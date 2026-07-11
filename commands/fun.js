const { pick, rand } = require('../utils/helpers');

const TRUTHS = [
  "What's your most embarrassing moment?",
  "Have you ever lied to get out of trouble?",
  "What's the worst thing you've ever done?",
  "Do you have a crush on anyone in this group?",
  "What's your biggest fear?",
  "Have you ever cheated on a test?",
  "What's the most childish thing you still do?",
  "What's a secret you've never told anyone?",
];

const DARES = [
  "Send your most embarrassing selfie.",
  "Text your crush right now.",
  "Change your profile picture to whatever we choose for 24 hours.",
  "Do 20 push-ups and send a video.",
  "Call a random contact and say 'I love you.'",
  "Post an embarrassing status for 1 hour.",
  "Send a voice note singing your favorite song.",
];

const JOKES = [
  "Why don't scientists trust atoms?\nBecause they make up everything! 😂",
  "What do you call a fake noodle?\nAn impasta! 🍝",
  "Why did the scarecrow win an award?\nBecause he was outstanding in his field! 🌾",
  "I told my wife she was drawing her eyebrows too high.\nShe looked surprised.",
  "Why do programmers prefer dark mode?\nBecause light attracts bugs! 🐛",
  "I asked the librarian if they had books about paranoia.\nShe whispered: 'They're right behind you!'",
];

const WYR = [
  { a: 'Be able to fly', b: 'Be able to be invisible' },
  { a: 'Never use social media again', b: 'Never watch movies again' },
  { a: 'Always be 10 minutes late', b: 'Always be 20 minutes early' },
  { a: 'Live without music', b: 'Live without TV' },
  { a: 'Have $1M now', b: 'Have $3M in 10 years' },
  { a: 'Speak all languages', b: 'Play all instruments' },
];

const POV = [
  "POV: You're the main character in an isekai anime.",
  "POV: The group chat just went silent after you sent that.",
  "POV: Your mom walks in at the worst time.",
  "POV: You wake up and realize it was all a dream.",
  "POV: Final boss music starts playing.",
];

const SOCIAL = [
  "Rate this group from 1-10 in the replies!",
  "Who in this group would survive a zombie apocalypse?",
  "Tag someone who is always MIA.",
  "Who texts back the fastest?",
];

const RELATION_TYPES = [
  'Best Friends', 'Rivals', 'Soulmates', 'Enemies', 'Siblings', 'Master & Student',
  'Hero & Sidekick', 'Teacher & Student', 'Frenemies',
];

const DUALITY_PAIRS = [
  ['Chaotic Evil', 'Lawful Good'],
  ['Night Owl', 'Early Bird'],
  ['Introvert', 'Extrovert'],
  ['Brain', 'Muscle'],
  ['The One Who Plans', 'The One Who Does Whatever'],
];

module.exports = {
  // .gay
  async gay(client, msg, args) {
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();
    const target = mentioned.length ? mentioned[0].pushname : contact.pushname;
    const percent = rand(0, 100);
    msg.reply(`🏳️‍🌈 *Gay Meter*\n\n${target} is *${percent}%* gay!\n${'🟪'.repeat(Math.floor(percent / 10))}${'⬛'.repeat(10 - Math.floor(percent / 10))}`);
  },

  // .lesbian
  async lesbian(client, msg, args) {
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();
    const target = mentioned.length ? mentioned[0].pushname : contact.pushname;
    const percent = rand(0, 100);
    msg.reply(`🏳️‍🌈 *Lesbian Meter*\n\n${target} is *${percent}%* lesbian!\n${'🌸'.repeat(Math.floor(percent / 10))}${'⬛'.repeat(10 - Math.floor(percent / 10))}`);
  },

  // .simp
  async simp(client, msg, args) {
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();
    const target = mentioned.length ? mentioned[0].pushname : contact.pushname;
    const percent = rand(0, 100);
    msg.reply(`🥺 *Simp Meter*\n\n${target} is *${percent}%* a simp!\n${'💗'.repeat(Math.floor(percent / 10))}${'⬛'.repeat(10 - Math.floor(percent / 10))}`);
  },

  // .ship [@user1] [@user2]
  async ship(client, msg, args) {
    const mentioned = await msg.getMentions();
    const contact = await msg.getContact();

    const p1 = mentioned[0] || contact;
    const p2 = mentioned[1] || contact;
    const percent = rand(0, 100);
    const heart = percent >= 70 ? '❤️' : percent >= 40 ? '🧡' : '💔';

    msg.reply(
      `💘 *Shipping*\n\n${p1.pushname} + ${p2.pushname}\n\n${heart} Compatibility: *${percent}%*\n${'❤️'.repeat(Math.floor(percent / 10))}${'🖤'.repeat(10 - Math.floor(percent / 10))}`
    );
  },

  // .skill
  async skill(client, msg, args) {
    const skills = ['Cooking', 'Gaming', 'Lying', 'Charming', 'Coding', 'Fighting', 'Sleeping', 'Drama', 'Roasting'];
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();
    const target = mentioned.length ? mentioned[0].pushname : contact.pushname;
    const skill = pick(skills);
    const level = rand(1, 100);
    msg.reply(`🎯 *Skill Check*\n\n${target}'s hidden skill: *${skill}*\nLevel: *${level}/100*`);
  },

  // .duality
  async duality(client, msg, args) {
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();
    const pair = pick(DUALITY_PAIRS);
    if (mentioned.length >= 2) {
      msg.reply(`☯️ *Duality*\n\n${mentioned[0].pushname}: *${pair[0]}*\n${mentioned[1].pushname}: *${pair[1]}*`);
    } else {
      msg.reply(`☯️ *Your Duality*\n\n*${pair[0]}* vs *${pair[1]}*\n\nWhich side are you on? 👀`);
    }
  },

  // .gen
  async gen(client, msg, args) {
    const gens = ['Gen Z', 'Millennial', 'Boomer', 'Alpha', 'Gen X'];
    const contact = await msg.getContact();
    const g = pick(gens);
    msg.reply(`🧬 *Generation Check*\n\n${contact.pushname}, you have the energy of a *${g}*!`);
  },

  // .pov
  async pov(client, msg, args) {
    msg.reply(`📽️ *POV*\n\n${pick(POV)}`);
  },

  // .social
  async social(client, msg, args) {
    msg.reply(`💬 *Social Game*\n\n${pick(SOCIAL)}`);
  },

  // .relation
  async relation(client, msg, args) {
    const mentioned = await msg.getMentions();
    if (mentioned.length < 2) return msg.reply('❌ Tag two people! .relation @user1 @user2');
    const rel = pick(RELATION_TYPES);
    msg.reply(`🔗 *Relationship*\n\n${mentioned[0].pushname} & ${mentioned[1].pushname} are...\n\n*${rel}* 🌟`);
  },

  // .pp
  async pp(client, msg, args) {
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();
    const target = mentioned.length ? mentioned[0].pushname : contact.pushname;
    const size = rand(1, 25);
    const bar = '8' + '='.repeat(size) + 'D';
    msg.reply(`📏 *PP Meter*\n\n${target}'s pp:\n${bar}\nSize: *${size} cm* 😂`);
  },

  // .wouldyourather
  async wouldyourather(client, msg, args) {
    const q = pick(WYR);
    msg.reply(`🤔 *Would You Rather?*\n\n🅰️ ${q.a}\n\nor\n\n🅱️ ${q.b}\n\nVote A or B!`);
  },

  // .joke
  async joke(client, msg, args) {
    msg.reply(`😂 *Joke*\n\n${pick(JOKES)}`);
  },

  // .truth
  async truth(client, msg, args) {
    const mentioned = await msg.getMentions();
    const target = mentioned.length ? `@${mentioned[0].number}` : 'someone';
    msg.reply(`🔍 *Truth for ${target}*\n\n${pick(TRUTHS)}`);
  },

  // .dare
  async dare(client, msg, args) {
    const mentioned = await msg.getMentions();
    const target = mentioned.length ? `@${mentioned[0].number}` : 'someone';
    msg.reply(`🎯 *Dare for ${target}*\n\n${pick(DARES)}`);
  },

  // .td — random truth or dare
  async td(client, msg, args) {
    const isTruth = Math.random() > 0.5;
    const mentioned = await msg.getMentions();
    const target = mentioned.length ? `@${mentioned[0].number}` : 'you';

    if (isTruth) {
      msg.reply(`🎲 *Truth for ${target}*\n\n🔍 ${pick(TRUTHS)}`);
    } else {
      msg.reply(`🎲 *Dare for ${target}*\n\n🎯 ${pick(DARES)}`);
    }
  },

  // .uno — start a silly uno card
  async uno(client, msg, args) {
    const colors = ['🔴', '🔵', '🟢', '🟡'];
    const values = ['1','2','3','4','5','6','7','8','9','Skip','Reverse','+2'];
    const card = `${pick(colors)} ${pick(values)}`;
    const special = Math.random() > 0.8 ? ' 🃏 *+4 Wild!*' : '';
    const contact = await msg.getContact();
    msg.reply(`🎴 *UNO!*\n\n${contact.pushname} plays: *${card}*${special}\n\nNext player's turn!`);
  },
};
