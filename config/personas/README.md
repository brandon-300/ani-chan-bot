# AI personas

Choose a persona with `AI_PERSONA=<id>` and restart the bot. The supplied project now includes `marin`, `karane`, and `rias`. Each directory owns its metadata and separate personality, text, and voice prompts, so character names and Fish Audio voices do not leak across personas.

| ID | Character | Series | Fish Audio voice |
| --- | --- | --- | --- |
| `marin` | Marin Kitagawa | My Dress-Up Darling | Existing project setting |
| `karane` | Karane Inda | The 100 Girlfriends Who Really, Really, Really, Really, Really Love You | `86b4af7035ad46b3b86170a0857dddff` |
| `rias` | Rias Gremory | High School DxD | `5d1ec8a03c444ee39074f209622a91aa` |

Each `meta.json` defines that character's `callNames`, `stickerAuthor`, and `voice.referenceId`. Leave `AI_CALL_NAMES` unset to use the selected persona's own names; setting it replaces the active persona's list only. `FISH_VOICE_ID` is a process-wide fallback/override, so leave it empty if the persona-specific IDs should be used.

AI reaction stickers are one shared library, not separate per-character collections. `.stickerimport` adds a sticker once; every persona can use it. Existing Mongo sticker records keep their old `personaId` as import provenance, but the bot now reads them all and reuses their current Cloudinary URLs. No re-import, Cloudinary migration, or manual database change is needed for stickers that were successfully saved before this update.

All persona text is instructed and sanitized to omit emoji, and `.tts` strips emoji from direct or quoted text. `.tts` sends no progress message: the dispatcher reaction is followed by the final voice note. The configured Fish Audio voice reference is passed directly; loudness normalization and extra pitch/effect filters are disabled, and WhatsApp delivery only transcodes the audio codec. Exact voice similarity still depends on the configured Fish Audio reference and model.

Persona replies use a supplied name as written and do not automatically append `-kun` or another honorific.

The prompts are original character guidance, not copied dialogue. Karane's profile leans into her prickly, easily flustered tsundere exterior and loyal, affectionate, dependable core. Rias is written as confident, compassionate, strategic, competitive, and playfully teasing; her emotional range is kept candid without turning every exchange into flirtation. Because Rias is portrayed in a high-school setting, the prompt keeps that portrayal age-appropriate.

Character-trait references used for grounding: [Crunchyroll's 100 Girlfriends character guide](https://www.crunchyroll.com/news/guides/2025/2/12/the-100-girlfriends-anime-characters) and the [High School DxD Wiki profile for Rias Gremory](https://highschooldxd.fandom.com/wiki/Rias_Gremory). These sources informed broad traits only; the prompt wording is newly written.
