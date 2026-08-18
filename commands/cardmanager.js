const axios = require('axios');
const { MessageMedia } = require('whatsapp-web.js');
const { isOwner, rollTier, tierEmoji, safeGetChat, cardValue, cleanDescription } = require('../utils/helpers');
const { CardCatalogue, OwnedCard, CatalogueGrowthState } = require('../models/Card');
const Group = require('../models/Group');

const TIERS = ['C', 'B', 'A', 'S', 'SS', 'SSS'];
const EDITABLE_FIELDS = ['name', 'series', 'tier', 'description', 'imageUrl'];
const ANILIST_URL = 'https://graphql.anilist.co';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Owner Guard ──────────────────────────────────────────────────────────────
async function checkOwner(msg) {
  const contact = await msg.getContact();
  if (!isOwner(contact.id._serialized)) {
    await msg.reply('❌ Only the bot owner can use this command.');
    return false;
  }
  return true;
}

// ─── Unique 6-char Card ID (matches the codes used by .claim) ────────────────
async function generateCardId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // skips ambiguous 0/O/1/I
  let id;
  let exists = true;
  while (exists) {
    id = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    exists = await CardCatalogue.findOne({ cardId: id });
  }
  return id;
}

// Same ownership query + sort as commands/cards.js's (private, unexported)
// getUserCards/getCardByIndex — duplicated here rather than importing across
// files, so .diagcard's numbering lines up exactly with .col/.cg/.card.
async function getOwnedCardByIndex(userId, index) {
  const cards = await OwnedCard.find({ ownerId: userId });
  cards.sort((a, b) => cardValue(a.tier) - cardValue(b.tier) || a.name.localeCompare(b.name));
  return cards[index - 1] || null;
}

// ─── AniList GraphQL Lookup ───────────────────────────────────────────────────
const CHARACTER_QUERY = `
query ($search: String) {
  Character(search: $search) {
    id
    name { full }
    image { large }
    description(asHtml: false)
    media(sort: POPULARITY_DESC, perPage: 1) {
      nodes {
        title { romaji english }
      }
    }
  }
}`;

// AniList is generally reliable but does rate-limit (429) under load; retry a
// couple times with backoff before giving up.
async function fetchAniListCharacter(name, attempt = 1) {
  try {
    const { data } = await axios.post(
      ANILIST_URL,
      { query: CHARACTER_QUERY, variables: { search: name } },
      {
        timeout: 15000,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
      }
    );
    return data?.data?.Character || null;
  } catch (err) {
    const status = err.response?.status;
    if (status === 404) return null; // no character matched this name

    const retryable = status === 429 || (status && status >= 500) || err.code === 'ECONNABORTED';
    if (retryable && attempt < 3) {
      await sleep(attempt * 1500);
      return fetchAniListCharacter(name, attempt + 1);
    }
    throw err;
  }
}

// AniList's character names are usually stored "Family Given" (romanized
// Japanese order) — so a card added as "Given Family" (e.g. "Yuji Itadori")
// can miss on a direct search even though the character is on AniList. Only
// kicks in for exactly-two-word names, and only after the direct search
// already came back empty, so it never changes behavior for a name that
// already matched fine.
async function fetchAniListCharacterSmart(name) {
  const direct = await fetchAniListCharacter(name);
  if (direct) return direct;

  const words = name.trim().split(/\s+/);
  if (words.length === 2) {
    return await fetchAniListCharacter(`${words[1]} ${words[0]}`);
  }
  return null;
}

function extractSeries(character) {
  const title = character?.media?.nodes?.[0]?.title;
  return title?.english || title?.romaji || 'Unknown';
}

function parseTierFromArgs(args) {
  const last = args[args.length - 1]?.toUpperCase();
  if (TIERS.includes(last)) return { tier: last, rest: args.slice(0, -1) };
  return { tier: null, rest: args };
}

// ─── Loose series match, used only by .backfillimages below ─────────────────
// A bare-name AniList search (e.g. "Sakura") can match the wrong character
// across different anime, so a found series has to at least loosely overlap
// the catalogue's existing series before that match gets auto-applied.
// Empty/"Unknown" counts as a pass — there's nothing to compare against.
//
// "Common" (utils/seedCards.js's generic filler monsters — Slime, Goblin,
// Witch, etc.) deliberately does NOT auto-pass, even though it might look
// like the same "nothing to compare against" case. It isn't: these names
// are generic enough that AniList's alias matching can and does resolve
// them to a real, unrelated character — a real run of this command matched
// "Witch" to Emilia (Re:Zero's Emilia carries a "Witch" epithet in-lore) and
// silently consumed her AniList ID, which then blocked the real Emilia
// catalogue entry from ever claiming it. Generic filler names have no
// correct AniList character to match at all, so every "Common" card should
// always land in manual review rather than risk a repeat of that collision.
//
// VTuber names (Hololive, currently) get a narrow bypass in the other
// direction: AniList frequently catalogues them under a spinoff 4-koma/
// webcomic title (e.g. "Holo no Graffiti") rather than the agency name
// itself, which made real matches for Mori Calliope/Gawr Gura/Ninomae Inanis
// fail the series-overlap check even though they were correct. A VTuber
// stage name is close to a unique identifier — there's no real ambiguity
// space of "other characters also named Mori Calliope" the way there is for
// a generic anime-trope name like Sakura/Emilia/Rem — so trusting the name
// match alone is safe specifically for this category.
//
// Genshin Impact gets the same bypass for the same underlying reason: AniList
// has no proper "anime" entry for the game itself, so a character's most-
// popular linked media often comes back as a manga/comic anthology spinoff
// (e.g. "Genshin Comic Anthology") instead of "Genshin Impact" — confirmed
// by real failures on Ganyu/Ayaka/Hu Tao, exactly parallel to the VTuber
// case above. Genshin character names (Ganyu, Hu Tao, Raiden Shogun, etc.)
// are similarly close to unique identifiers, so the same reasoning applies.
const NAME_TRUSTED_SERIES_KEYWORDS = ['hololive', 'nijisanji', 'vtuber', 'genshin impact'];

function seriesLooselyMatches(existingSeries, foundSeries) {
  if (existingSeries === 'Common') return false;
  if (NAME_TRUSTED_SERIES_KEYWORDS.some(k => (existingSeries || '').toLowerCase().includes(k))) return true;
  if (!existingSeries || existingSeries === 'Unknown') return true;
  const a = existingSeries.toLowerCase();
  const b = (foundSeries || '').toLowerCase();
  if (!b) return false;
  return a.includes(b) || b.includes(a);
}

// ─── Core: look up a character on AniList and save it to the catalogue ──────
async function createCardFromAniList(name, tierOverride) {
  const character = await fetchAniListCharacter(name);
  if (!character) return { error: `No AniList character found for "${name}".` };

  const dup = await CardCatalogue.findOne({ anilistId: character.id });
  if (dup) return { error: `*${dup.name}* is already in the catalogue [${dup.cardId}].` };

  const card = await CardCatalogue.create({
    cardId: await generateCardId(),
    anilistId: character.id,
    name: character.name?.full || name,
    series: extractSeries(character),
    tier: tierOverride || rollTier(),
    imageUrl: character.image?.large || '',
    description: cleanDescription(character.description)
  });

  return { card };
}

// ─── Catalogue Auto-Growth (background AniList discovery) ───────────────────
// Goal: let the catalogue grow into the hundreds on its own, the way bigger
// card bots do, instead of only ever growing through .addcard/.bulkadd.
//
// Strategy: walk AniList's anime list ordered by popularity, page by page,
// and pull each anime's most-favourited characters. Characters already in
// the catalogue (matched by anilistId) are skipped; so are any whose NAME
// already exists under a different entry — that second check is specifically
// so this background job never manufactures a fresh "Goku / Gokuu Son"-style
// duplicate while Brandon is still working through the existing ones with
// .mergecards. Progress (which AniList page to resume from) is saved in
// CatalogueGrowthState so repeated runs keep pushing into less-popular —
// i.e. newer-to-the-catalogue — territory instead of re-scanning the same
// top titles forever.
//
// Off by default — .autoexpand on/off/now/status controls it. Runs a small,
// capped batch on a timer so it stays gentle on both AniList's rate limits
// and Brandon's mobile data.
const DISCOVERY_QUERY = `
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    media(sort: POPULARITY_DESC, type: ANIME) {
      title { romaji english }
      characters(sort: FAVOURITES_DESC, perPage: 3) {
        nodes {
          id
          name { full }
          image { large }
          description(asHtml: false)
        }
      }
    }
  }
}`;

const DISCOVERY_MEDIA_PER_PAGE = 5;      // anime scanned per run
const DISCOVERY_ADD_CAP = 8;             // new cards added per run, max
const DISCOVERY_INTERVAL_MS = 20 * 60 * 1000; // 20 minutes between runs

async function fetchDiscoveryPage(page, attempt = 1) {
  try {
    const { data } = await axios.post(
      ANILIST_URL,
      { query: DISCOVERY_QUERY, variables: { page, perPage: DISCOVERY_MEDIA_PER_PAGE } },
      { timeout: 15000, headers: { 'Content-Type': 'application/json', Accept: 'application/json' } }
    );
    return data?.data?.Page || null;
  } catch (err) {
    const status = err.response?.status;
    const retryable = status === 429 || (status && status >= 500) || err.code === 'ECONNABORTED';
    if (retryable && attempt < 3) {
      await sleep(attempt * 1500);
      return fetchDiscoveryPage(page, attempt + 1);
    }
    throw err;
  }
}

// A regex-escaped, exact (case-insensitive) name match — used to check for
// "same character, different catalogue entry" before adding, same idea as
// the anilistId dedup but for entries that never got an anilistId at all.
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function runDiscoveryBatch() {
  const state = await CatalogueGrowthState.findByIdAndUpdate(
    'singleton', {}, { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  if (!state.enabled) return { skipped: true };

  let added = 0;
  let page = state.page;
  let hasNextPage = true;

  try {
    // Cap the number of AniList pages walked per run too (not just cards
    // added) so a stretch of already-owned popular characters can't turn one
    // background run into a long chain of requests.
    for (let pagesWalked = 0; added < DISCOVERY_ADD_CAP && hasNextPage && pagesWalked < 5; pagesWalked++) {
      const pageData = await fetchDiscoveryPage(page);
      if (!pageData) break;
      hasNextPage = !!pageData.pageInfo?.hasNextPage;

      for (const media of pageData.media || []) {
        const series = media.title?.english || media.title?.romaji || 'Unknown';

        for (const character of media.characters?.nodes || []) {
          if (added >= DISCOVERY_ADD_CAP) break;
          if (!character?.id || !character.name?.full) continue;

          const existsById = await CardCatalogue.findOne({ anilistId: character.id });
          if (existsById) continue;

          const existsByName = await CardCatalogue.findOne({
            name: new RegExp(`^${escapeRegex(character.name.full)}$`, 'i')
          });
          if (existsByName) continue;

          await CardCatalogue.create({
            cardId: await generateCardId(),
            anilistId: character.id,
            name: character.name.full,
            series,
            tier: rollTier(),
            imageUrl: character.image?.large || '',
            description: cleanDescription(character.description),
          });
          added++;
        }
        if (added >= DISCOVERY_ADD_CAP) break;
      }

      if (added < DISCOVERY_ADD_CAP) {
        if (!hasNextPage) { page = 1; break; } // exhausted AniList — wrap around
        page++;
      }
    }

    await CatalogueGrowthState.findByIdAndUpdate('singleton', {
      $set: { page, lastRunAt: new Date(), lastError: null },
      $inc: { totalAdded: added },
    });

    return { added, page };
  } catch (err) {
    await CatalogueGrowthState.findByIdAndUpdate('singleton', {
      $set: { lastRunAt: new Date(), lastError: err.message },
    }).catch(() => {});
    throw err;
  }
}

let discoveryIntervalId = null;

function startDiscoveryInterval() {
  if (discoveryIntervalId) clearInterval(discoveryIntervalId);
  discoveryIntervalId = setInterval(() => {
    runDiscoveryBatch().catch(err => console.error('Catalogue auto-growth error:', err.message));
  }, DISCOVERY_INTERVAL_MS);
}

function stopDiscoveryInterval() {
  if (discoveryIntervalId) {
    clearInterval(discoveryIntervalId);
    discoveryIntervalId = null;
  }
}

// Called once from index.js on bot startup, same pattern as cards.js's
// _initCardDrops — only actually starts the timer if .autoexpand was left
// ON from before the last restart.
async function _initCatalogueGrowth(client) {
  const state = await CatalogueGrowthState.findByIdAndUpdate(
    'singleton', {}, { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  if (state.enabled) {
    startDiscoveryInterval();
    console.log('📈 Resumed catalogue auto-growth (was left ON)');
  }
}

module.exports = {
  _initCatalogueGrowth,
  // .addcard <character name> [tier]
  async addcard(client, msg, args) {
    if (!(await checkOwner(msg))) return;

    if (!args.length) {
      return msg.reply(
        'Usage:\n.addcard <character name> [tier]\n\nExample:\n.addcard Gojo Satoru\n.addcard Gojo Satoru SS'
      );
    }

    const { tier, rest } = parseTierFromArgs(args);
    const name = rest.join(' ').trim();
    if (!name) return msg.reply('❌ Please provide a character name.');

    await msg.reply(`🔍 Searching AniList for *${name}*...`);

    try {
      const { card, error } = await createCardFromAniList(name, tier);
      if (error) return msg.reply(`❌ ${error}`);

      const caption =
        `✅ *Card Added!*\n\n` +
        `🆔 ${card.cardId}\n` +
        `👤 ${card.name}\n` +
        `📺 ${card.series}\n` +
        `${tierEmoji(card.tier)} Tier: ${card.tier}`;

      const chat = await safeGetChat(msg);
    if (!chat) return;
      if (!chat) return;
      if (card.imageUrl) {
        try {
          const media = await MessageMedia.fromUrl(card.imageUrl, { unsafeMime: true });
          return await chat.sendMessage(media, { caption });
        } catch {
          // image fetch failed — fall through to text-only reply
        }
      }
      await msg.reply(caption);
    } catch (err) {
      console.error('addcard error:', JSON.stringify({
        status: err.response?.status || null,
        data: err.response?.data || null,
        code: err.code || null,
        message: err.message || null
      }));
      msg.reply('❌ Failed to fetch data from AniList. Try again in a moment.');
    }
  },

  // .bulkadd — one character per line (optional tier at the end of the line),
  // or comma-separated on a single line. Max 20 per batch.
  //
  // Example:
  // .bulkadd
  // Gojo Satoru
  // Nezuko Kamado SS
  // Zero Two SSS
  async bulkadd(client, msg, args) {
    if (!(await checkOwner(msg))) return;

    // Pull from the raw message body so newlines survive (index.js collapses
    // whitespace, including newlines, when it builds `args`).
    const text = (msg.body || '').replace(/^\S+\s*/, '').trim();
    const lines = text.split(/\n|,/).map(l => l.trim()).filter(Boolean);

    if (!lines.length) {
      return msg.reply(
        'Usage — one character per line, optional tier at the end:\n\n' +
        '.bulkadd\nGojo Satoru\nNezuko Kamado SS\nZero Two SSS\n\n' +
        '(Comma-separated on one line also works. Max 20 per batch.)'
      );
    }

    if (lines.length > 20) {
      return msg.reply('❌ Max 20 characters per .bulkadd batch. Split it into smaller batches.');
    }

    await msg.reply(`🔍 Adding ${lines.length} character(s)... this'll take a bit, hang tight.`);

    const added = [];
    const skipped = [];

    for (const line of lines) {
      const { tier, rest } = parseTierFromArgs(line.split(/\s+/));
      const name = rest.join(' ').trim();
      if (!name) continue;

      try {
        const { card, error } = await createCardFromAniList(name, tier);
        if (error) skipped.push(`${name} — ${error}`);
        else added.push(`${tierEmoji(card.tier)} ${card.name} [${card.tier}] (${card.cardId})`);
      } catch (err) {
        skipped.push(`${name} — lookup failed`);
      }

      await sleep(500); // spacing between requests
    }

    let reply = `📦 *Bulk Add Complete*\n\n✅ Added: ${added.length}\n❌ Skipped: ${skipped.length}\n`;
    if (added.length) reply += `\n*Added:*\n${added.join('\n')}`;
    if (skipped.length) reply += `\n\n*Skipped:*\n${skipped.join('\n')}`;

    msg.reply(reply.slice(0, 4000));
  },

  // .delcard <card id>
  // .delcard <card id> [force] — deletes a catalogue entry. If anyone has
  // already claimed a copy, deleting the template out from under them would
  // leave those OwnedCard docs pointing at nothing (exactly what .repairlinks
  // flags as "no catalogue row named X exists" — a permanent orphan, since
  // there's nothing left to re-link to). Refuses by default when copies
  // exist; "force" deletes the catalogue entry AND every claimed copy of it.
  async delcard(client, msg, args) {
    if (!(await checkOwner(msg))) return;

    const id = args[0]?.trim().toUpperCase();
    const force = (args[1] || '').toLowerCase() === 'force';
    if (!id) return msg.reply('Usage:\n.delcard <card id> [force]');

    const target = await CardCatalogue.findOne({ cardId: id });
    if (!target) return msg.reply('❌ Card not found. Use the 6-character card ID (see .cardstats or .ci to look one up).');

    const ownedCount = await OwnedCard.countDocuments({ catalogueId: id });
    if (ownedCount > 0 && !force) {
      return msg.reply(
        `⚠️ *${target.name}* [${id}] has ${ownedCount} claimed copy/copies out there.\n\n` +
        `Deleting the catalogue entry deletes those claimed copies too — there's nothing left for them to point to otherwise.\n\n` +
        `Run *.delcard ${id} force* to delete both.`
      );
    }

    if (ownedCount > 0) await OwnedCard.deleteMany({ catalogueId: id });
    await CardCatalogue.deleteOne({ cardId: id });

    msg.reply(`🗑 Deleted card:\n${target.name} [${id}]${ownedCount > 0 ? `\n📦 Also removed ${ownedCount} claimed copy/copies.` : ''}`);
  },

  // .editcard <card id> <field> <value>
  async editcard(client, msg, args) {
    if (!(await checkOwner(msg))) return;

    const [rawId, field, ...valueParts] = args;
    const value = valueParts.join(' ').trim();

    if (!rawId || !field || !value) {
      return msg.reply(
        `Usage:\n.editcard <id> <field> <value>\n\nFields:\n${EDITABLE_FIELDS.join('\n')}\n\nExample:\n.editcard AB12CD tier SS`
      );
    }

    if (!EDITABLE_FIELDS.includes(field)) {
      return msg.reply(`❌ Invalid field. Choose from:\n${EDITABLE_FIELDS.join('\n')}`);
    }

    if (field === 'tier' && !TIERS.includes(value.toUpperCase())) {
      return msg.reply(`❌ Invalid tier. Choose from: ${TIERS.join(', ')}`);
    }

    // EDITABLE_FIELDS (name/series/tier/description/imageUrl) are exactly
    // the fields the custom card renderer (utils/cardRenderer.js) draws
    // from, so ANY successful edit here invalidates the cached rendered
    // PNG — otherwise the bot would keep serving a now-stale card face
    // until CARD_RENDER_VERSION is next bumped. This doesn't delete the
    // old file from Cloudinary; the next render reuses the same
    // deterministic public_id (card_<id>_v<version>) with overwrite:true,
    // which replaces it in place.
    const update = {
      [field]: field === 'tier' ? value.toUpperCase() : value,
      renderedUrl: null,
      renderVersion: null,
      renderedAt: null,
    };

    const card = await CardCatalogue.findOneAndUpdate(
      { cardId: rawId.toUpperCase() },
      { $set: update },
      { new: true }
    );

    if (!card) return msg.reply('❌ Card not found.');

    msg.reply(`✅ Updated *${field}* for ${card.name} [${card.cardId}]\n${field}: ${card[field]}`);
  },

  // .reloadcards — there's no in-memory cache anywhere in the bot; every
  // command reads straight from MongoDB, so .addcard/.editcard/.delcard take
  // effect immediately. This just confirms the DB is reachable and live.
  async reloadcards(client, msg) {
    if (!(await checkOwner(msg))) return;

    try {
      const total = await CardCatalogue.countDocuments();
      msg.reply(
        `✅ Catalogue is live: *${total}* card(s) in MongoDB.\n` +
        `ℹ️ No caching layer exists, so changes always apply instantly — nothing to reload.`
      );
    } catch (err) {
      msg.reply('❌ Could not reach the database.');
    }
  },

  // .cardstats
  async cardstats(client, msg) {
    if (!(await checkOwner(msg))) return;

    const total = await CardCatalogue.countDocuments();
    const claimedIds = await OwnedCard.distinct('catalogueId');
    const claimed = claimedIds.length;

    let text = `📊 *Card Database Statistics*\n\n`;
    text += `Total Cards: ${total}\n`;
    text += `🔓 Claimed: ${claimed}\n`;
    text += `📦 Unclaimed: ${Math.max(total - claimed, 0)}\n\n`;
    text += `*By Tier:*\n`;

    for (const tier of ['SSS', 'SS', 'S', 'A', 'B', 'C']) {
      const count = await CardCatalogue.countDocuments({ tier });
      text += `${tierEmoji(tier)} ${tier}: ${count}\n`;
    }

    msg.reply(text);
  },

  // .backfillimages — fixes catalogue entries that predate the AniList
  // pipeline. utils/seedCards.js (the original bulk-seed script) only ever
  // wrote name/series/tier — no anilistId or imageUrl — which is why .cg
  // (card grid) and .card/.ci show blank tiles for those cards instead of
  // real art. migrateCardIds.js was run separately at some point and
  // already gave every catalogue entry a cardId (and fixed up matching
  // OwnedCard.catalogueId links to it), so cardId is NOT a useful signal
  // here — anilistId is: it's only ever set by createCardFromAniList
  // (.addcard/.bulkadd/this command), so a missing anilistId means a card
  // never actually went through AniList.
  //
  // This finds every catalogue entry still missing an anilistId, looks it
  // up on AniList by name, and fills in anilistId/imageUrl/description —
  // WITHOUT touching the existing cardId, name, series, or tier. cardId is
  // deliberately left alone: OwnedCard.catalogueId already correctly points
  // at each card's current cardId (via migrateCardIds.js), and changing it
  // here would just break that link again for no reason. name/series/tier
  // are left alone because a bare-name AniList search can occasionally
  // match the wrong character (multiple "Sakura"s exist across different
  // anime, for instance) — safer to only add new data than to risk
  // overwriting something Brandon chose deliberately.
  //
  // Safety: a match only gets auto-applied when the series AniList returns
  // loosely overlaps the catalogue's existing series field (see
  // seriesLooselyMatches above). Anything else — including generic filler
  // cards like the "Common"-series Slime/Goblin/Fairy entries, which were
  // never real AniList characters to begin with — is left completely
  // untouched and reported as "needs manual review" instead of risking the
  // wrong image getting attached to the wrong character. Use .editcard
  // <id> imageUrl <url> by hand for anything that lands in that bucket.
  //
  // Capped at 25 per run (same spirit as .bulkadd's 20-cap) so one call
  // can't hang for minutes straight on a phone-class connection; run it
  // again to keep working through the rest if your catalogue has more than
  // that still missing an anilistId.
  async backfillimages(client, msg, args) {
    if (!(await checkOwner(msg))) return;

    const BATCH_LIMIT = 25;
    const missing = await CardCatalogue.find({
      $or: [{ anilistId: { $exists: false } }, { anilistId: null }],
    }).limit(BATCH_LIMIT);

    if (!missing.length) {
      return msg.reply('✅ Every catalogue card already has AniList data — nothing to backfill.');
    }

    await msg.reply(`🔍 Backfilling images for ${missing.length} card(s)... this'll take a bit, hang tight.`);

    const applied = [];
    const skipped = [];

    for (const doc of missing) {
      try {
        const character = await fetchAniListCharacterSmart(doc.name);
        if (!character) {
          skipped.push(`${doc.name} [${doc.cardId}] — no AniList match found; add the image by hand with .editcard ${doc.cardId} imageUrl <url>`);
          await sleep(500);
          continue;
        }

        const foundSeries = extractSeries(character);
        if (!seriesLooselyMatches(doc.series, foundSeries)) {
          skipped.push(`${doc.name} [${doc.cardId}] — AniList matched "${foundSeries}", doesn't look like your "${doc.series}"; review manually with .editcard`);
          await sleep(500);
          continue;
        }

        const dup = await CardCatalogue.findOne({ anilistId: character.id });
        if (dup) {
          // Two different collisions land here, and they need two different
          // fixes — tell Brandon which one this is and give him the exact
          // command to run:
          //   - dup is a real named character too -> genuine duplicate
          //     catalogue entry (e.g. "Goku" / "Gokuu Son") -> .mergecards
          //   - dup is a generic "Common" filler card (Slime/Witch/etc.)
          //     that matched this AniList id first -> it's squatting on the
          //     real card's data -> .stealimage pulls it back
          const suggestion = dup.series === 'Common'
            ? `.stealimage ${dup.cardId} ${doc.cardId}`
            : `.mergecards ${dup.cardId} ${doc.cardId}`;
          skipped.push(`${doc.name} [${doc.cardId}] — that AniList character is already used by ${dup.name} [${dup.cardId}]. Try: ${suggestion}`);
          await sleep(500);
          continue;
        }

        doc.anilistId = character.id;
        doc.imageUrl = character.image?.large || '';
        doc.description = cleanDescription(character.description);
        await doc.save();

        applied.push(`✅ ${doc.name} [${doc.cardId}]`);
      } catch (err) {
        skipped.push(`${doc.name} — lookup failed (${err.message})`);
      }
      await sleep(500); // AniList rate-limit spacing, same as .bulkadd
    }

    const remaining = await CardCatalogue.countDocuments({
      $or: [{ anilistId: { $exists: false } }, { anilistId: null }],
    });

    let reply = `🖼️ *Backfill Complete*\n\n✅ Fixed: ${applied.length}\n⚠️ Needs review: ${skipped.length}\n`;
    if (applied.length) reply += `\n*Fixed:*\n${applied.join('\n')}`;
    if (skipped.length) reply += `\n\n*Needs manual review:*\n${skipped.join('\n')}`;
    if (remaining > 0) reply += `\n\n📦 ${remaining} more still missing AniList data — run *.backfillimages* again to keep going.`;

    msg.reply(reply.slice(0, 4000));
  },

  // .mergecards <keepId> <duplicateId> — for genuine duplicate catalogue
  // entries (two different cardIds that are actually the same character —
  // e.g. "Goku" and "Gokuu Son" both resolving to the same AniList id).
  // Reassigns every claimed copy of the duplicate over to the keeper
  // (nobody's claim disappears) and re-syncs the denormalized name/series/
  // tier OwnedCard keeps its own copy of, clears the duplicate off any
  // currently-active group drop, then deletes the duplicate catalogue entry.
  // NOT for the "filler card squatting on a real character's AniList id"
  // collision (e.g. Witch holding Emilia's id) — use .stealimage for that.
  // .backfillimages' skip messages tell you which one applies and hand you
  // the exact command to run.
  async mergecards(client, msg, args) {
    if (!(await checkOwner(msg))) return;

    const keepId = args[0]?.trim().toUpperCase();
    const dupId = args[1]?.trim().toUpperCase();
    if (!keepId || !dupId) {
      return msg.reply(
        'Usage:\n.mergecards <cardId to keep> <duplicate cardId to remove>\n\n' +
        'Moves any claimed copies of the duplicate over to the keeper, then deletes the duplicate catalogue entry.'
      );
    }
    if (keepId === dupId) return msg.reply('❌ Those are the same card ID.');

    const [keep, dup] = await Promise.all([
      CardCatalogue.findOne({ cardId: keepId }),
      CardCatalogue.findOne({ cardId: dupId }),
    ]);
    if (!keep) return msg.reply(`❌ Card ${keepId} not found.`);
    if (!dup) return msg.reply(`❌ Card ${dupId} not found.`);

    const moved = await OwnedCard.updateMany(
      { catalogueId: dupId },
      { $set: { catalogueId: keepId, name: keep.name, series: keep.series, tier: keep.tier } }
    );

    await Group.updateMany({ activeCardId: dupId }, { $set: { activeCardId: keepId } });
    await CardCatalogue.deleteOne({ cardId: dupId });

    msg.reply(
      `✅ Merged *${dup.name}* [${dupId}] into *${keep.name}* [${keepId}].\n` +
      `📦 Reassigned ${moved.modifiedCount} claimed copy/copies.\n` +
      `🗑 Deleted the duplicate catalogue entry.`
    );
  },

  // .stealimage <fromId> <toId> — moves anilistId/imageUrl/description off
  // one catalogue card onto another, clearing them from the source. Built
  // for the exact collision documented above seriesLooselyMatches: a generic
  // filler card (Common tier — Slime/Witch/Goblin/etc.) whose bare name
  // happened to match a real character's AniList entry (Witch -> Emilia,
  // since Re:Zero's Emilia carries a "Witch" epithet in-lore) and locked in
  // that id before the real card could claim it.
  async stealimage(client, msg, args) {
    if (!(await checkOwner(msg))) return;

    const fromId = args[0]?.trim().toUpperCase();
    const toId = args[1]?.trim().toUpperCase();
    if (!fromId || !toId) {
      return msg.reply(
        'Usage:\n.stealimage <cardId currently holding the AniList data> <cardId that should have it>\n\n' +
        'Clears anilistId/imageUrl/description off the first and moves them onto the second.'
      );
    }
    if (fromId === toId) return msg.reply('❌ Those are the same card ID.');

    const from = await CardCatalogue.findOne({ cardId: fromId });
    if (!from) return msg.reply(`❌ Card ${fromId} not found.`);
    const to = await CardCatalogue.findOne({ cardId: toId });
    if (!to) return msg.reply(`❌ Card ${toId} not found.`);
    if (!from.anilistId) return msg.reply(`❌ ${from.name} [${fromId}] doesn't have any AniList data to move.`);

    const { anilistId, imageUrl, description } = from;

    // Clear the source and save first — anilistId is unique+sparse, so both
    // documents can never hold the same value at once; clearing before
    // setting avoids a duplicate-key error on the second save.
    from.anilistId = undefined;
    from.imageUrl = '';
    from.description = '';
    await from.save();

    try {
      to.anilistId = anilistId;
      to.imageUrl = imageUrl;
      to.description = description;
      await to.save();
    } catch (err) {
      // Best-effort rollback so a failure here never strands the AniList
      // data on neither card.
      from.anilistId = anilistId;
      from.imageUrl = imageUrl;
      from.description = description;
      await from.save().catch(() => {});
      return msg.reply(`❌ Failed to move data onto ${toId}: ${err.message}. Rolled back — ${fromId} still has it.`);
    }

    msg.reply(
      `✅ Moved AniList data from *${from.name}* [${fromId}] to *${to.name}* [${toId}].\n` +
      `${fromId} is now clear for a fresh .backfillimages or manual .editcard.`
    );
  },

  // .autoexpand on|off|now|status — controls the background AniList
  // discovery job (see runDiscoveryBatch above). Off by default.
  async autoexpand(client, msg, args) {
    if (!(await checkOwner(msg))) return;
    const sub = (args[0] || 'status').toLowerCase();

    if (sub === 'on') {
      const state = await CatalogueGrowthState.findByIdAndUpdate(
        'singleton', { $set: { enabled: true } }, { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      startDiscoveryInterval();
      return msg.reply(
        `✅ Auto-expand is ON.\n\n` +
        `Every ${DISCOVERY_INTERVAL_MS / 60000} minutes the bot pulls a small batch (up to ${DISCOVERY_ADD_CAP} cards) of new characters from AniList's most-popular anime and adds them to the catalogue — skipping anything already added.\n\n` +
        `Resuming from AniList page ${state.page}. *.autoexpand status* to check progress, *.autoexpand off* to stop, *.autoexpand now* to run one batch immediately.`
      );
    }

    if (sub === 'off') {
      await CatalogueGrowthState.findByIdAndUpdate('singleton', { $set: { enabled: false } }, { upsert: true });
      stopDiscoveryInterval();
      return msg.reply('🛑 Auto-expand is OFF. The catalogue won\'t grow on its own until you turn it back on.');
    }

    if (sub === 'now') {
      await msg.reply('🔍 Running one auto-expand batch now... this makes a few AniList calls, hang tight.');
      try {
        const result = await runDiscoveryBatch();
        if (result.skipped) return msg.reply('⚠️ Auto-expand is currently OFF — turn it on first with *.autoexpand on*.');
        return msg.reply(`✅ Added ${result.added} new card(s) this batch. Next AniList page to scan: ${result.page}.`);
      } catch (err) {
        return msg.reply(`❌ Batch failed: ${err.message}`);
      }
    }

    const state = await CatalogueGrowthState.findById('singleton');
    const total = await CardCatalogue.countDocuments();
    return msg.reply(
      `📈 *Catalogue Auto-Expand*\n\n` +
      `Status: ${state?.enabled ? '✅ ON' : '🛑 OFF'}\n` +
      `Catalogue size: ${total} card(s)\n` +
      `Auto-added so far: ${state?.totalAdded || 0}\n` +
      `AniList page cursor: ${state?.page || 1}\n` +
      `Last run: ${state?.lastRunAt ? new Date(state.lastRunAt).toLocaleString() : 'never'}\n` +
      (state?.lastError ? `⚠️ Last error: ${state.lastError}\n` : '') +
      `\nUsage: *.autoexpand on / off / now / status*`
    );
  },

  // .diagcard <index> — raw diagnostic dump for one of YOUR owned cards
  // (same numbering as .col/.cg/.card). Answers, with no guessing: what
  // catalogueId is actually stored on the OwnedCard doc, whether that id
  // resolves to a real CardCatalogue row at all, what that row's anilistId/
  // imageUrl actually are, and — the real duplicate check — every catalogue
  // row that shares this card's exact name, so you can see for certain
  // whether there's a second entry and which one your card is linked to.
  // Read-only, changes nothing.
  async diagcard(client, msg, args) {
    if (!(await checkOwner(msg))) return;

    const index = parseInt(args[0]);
    if (!index || index < 1) {
      return msg.reply('❌ Usage: .diagcard [index] — same numbering as .col/.cg/.card.');
    }

    const contact = await msg.getContact();
    const owned = await getOwnedCardByIndex(contact.id._serialized, index);
    if (!owned) return msg.reply(`❌ No card at position ${index}.`);

    const rawId = owned.catalogueId;
    const catalogue = rawId ? await CardCatalogue.findOne({ cardId: rawId }) : null;
    const sameName = await CardCatalogue.find({ name: owned.name });

    let reply = `🔬 *Diagnostic — ${owned.name}* (position ${index})\n\n`;
    reply += `OwnedCard.catalogueId (raw value): ${
      rawId === undefined ? 'undefined' : rawId === null ? 'null' : `"${rawId}"`
    }\n\n`;

    reply += catalogue
      ? `✅ Resolves to catalogue row [${catalogue.cardId}]\n• anilistId: ${catalogue.anilistId ?? 'none'}\n• imageUrl: ${catalogue.imageUrl ? `set (${catalogue.imageUrl.length} chars)` : 'EMPTY'}\n`
      : `❌ Does NOT resolve to any catalogue row — "${rawId}" doesn't exist in CardCatalogue at all (dangling reference).\n`;

    reply += `\nCatalogue rows named exactly "${owned.name}": ${sameName.length}\n`;
    sameName.forEach(c => {
      const marker = c.cardId === rawId ? '  ← your card is linked to this one' : '';
      reply += `• [${c.cardId}] anilistId:${c.anilistId ?? 'none'} image:${c.imageUrl ? 'yes' : 'no'}${marker}\n`;
    });

    msg.reply(reply.slice(0, 4000));
  },

  // .repairlinks — bulk repair for OwnedCard.catalogueId values that don't
  // resolve to any real CardCatalogue row. Root cause: an old (long since
  // fixed) version of .claim stringified a whole CardCatalogue document into
  // catalogueId instead of its cardId — see .diagcard's output for what that
  // garbage looks like. migrateCardIds.js's later cardId migration only
  // re-linked cards whose catalogueId was still a clean Mongo ObjectId
  // string, so anything already corrupted before that migration ran was
  // silently left broken.
  //
  // Repair strategy: OwnedCard.name/series were denormalized (copied) onto
  // the owned card at claim time and are untouched by this corruption, so
  // they're used to find the real catalogue row. Only auto-fixes an exact,
  // unambiguous name match with agreeing series — zero or multiple matches
  // get reported instead of guessed at, same caution as .backfillimages.
  async repairlinks(client, msg, args) {
    if (!(await checkOwner(msg))) return;

    const REPAIR_LIMIT = 100;
    const owned = await OwnedCard.find().limit(REPAIR_LIMIT);
    if (!owned.length) return msg.reply('✅ No owned cards exist yet — nothing to check.');

    const fixed = [];
    const skipped = [];

    for (const card of owned) {
      const resolved = card.catalogueId
        ? await CardCatalogue.findOne({ cardId: card.catalogueId })
        : null;
      if (resolved) continue; // already links fine, leave it alone

      const candidates = await CardCatalogue.find({ name: card.name });
      if (candidates.length === 0) {
        skipped.push(`${card.name} [code ${card.code}] — no catalogue row named "${card.name}" exists; may need .addcard`);
        continue;
      }
      if (candidates.length > 1) {
        skipped.push(`${card.name} [code ${card.code}] — ${candidates.length} catalogue rows share that name (${candidates.map(c => c.cardId).join(', ')}); pick the right one and fix manually`);
        continue;
      }

      const match = candidates[0];
      if (card.series && match.series && card.series !== match.series) {
        skipped.push(`${card.name} [code ${card.code}] — name matches but series doesn't (yours: "${card.series}", catalogue: "${match.series}"); review manually`);
        continue;
      }

      card.catalogueId = match.cardId;
      await card.save();
      fixed.push(`✅ ${card.name} [code ${card.code}] → linked to [${match.cardId}]`);
    }

    let reply = `🔧 *Link Repair*\n\n✅ Fixed: ${fixed.length}\n⚠️ Skipped: ${skipped.length}\n`;
    if (fixed.length) reply += `\n*Fixed:*\n${fixed.join('\n')}`;
    if (skipped.length) reply += `\n\n*Needs manual review:*\n${skipped.join('\n')}`;
    if (owned.length === REPAIR_LIMIT) reply += `\n\n📦 Checked the first ${REPAIR_LIMIT} owned cards — run *.repairlinks* again if you have more.`;

    msg.reply(reply.slice(0, 4000));
  },

  // .purgeorphans [confirm] — removes OwnedCard copies whose catalogue entry
  // is genuinely gone (deleted by the old .delcard, before it cascaded —
  // see the fix above). This is exactly the "no catalogue row named X
  // exists" case .repairlinks reports and can't fix on its own, since there's
  // nothing left to re-link to. Preview-only by default; add "confirm" to
  // actually delete, since this permanently removes whatever collectible
  // those copies represented.
  async purgeorphans(client, msg, args) {
    if (!(await checkOwner(msg))) return;

    const confirm = (args[0] || '').toLowerCase() === 'confirm';
    const owned = await OwnedCard.find().limit(200);

    const orphans = [];
    for (const card of owned) {
      const resolved = card.catalogueId ? await CardCatalogue.findOne({ cardId: card.catalogueId }) : null;
      if (resolved) continue;
      const byName = await CardCatalogue.findOne({ name: card.name });
      if (byName) continue; // .repairlinks can fix this one — not a true orphan
      orphans.push(card);
    }

    if (!orphans.length) return msg.reply('✅ No orphaned owned cards found.');

    if (!confirm) {
      const preview = orphans.slice(0, 30).map(c => `• ${c.name} [code ${c.code || 'none'}]`).join('\n');
      return msg.reply(
        `⚠️ Found ${orphans.length} owned card(s) whose catalogue entry no longer exists:\n\n${preview}` +
        (orphans.length > 30 ? `\n...and ${orphans.length - 30} more` : '') +
        `\n\nThis permanently removes the players' copies too — run *.purgeorphans confirm* to actually delete them.`
      );
    }

    await OwnedCard.deleteMany({ _id: { $in: orphans.map(c => c._id) } });
    msg.reply(`🗑 Removed ${orphans.length} orphaned owned card(s).`);
  },
};
