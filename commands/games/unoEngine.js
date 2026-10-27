const COLORS = ['red', 'yellow', 'green', 'blue'];
function shuffled(cards, random = Math.random) {
  const deck = cards.slice();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
function deck() {
  const cards = [];
  for (const color of COLORS) {
    cards.push({ color, value: '0' });
    for (const value of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', '+2'])
      for (let i = 0; i < 2; i++) cards.push({ color, value });
  }
  for (const value of ['wild', '+4'])
    for (let i = 0; i < 4; i++) cards.push({ color: 'wild', value });
  return cards;
}
function next(game, steps = 1) {
  return (
    (game.turn + ((game.direction * steps) % game.players.length) + game.players.length) %
    game.players.length
  );
}
function drawCards(game, playerId, count) {
  for (let i = 0; i < count; i++) {
    if (!game.deck.length) {
      const top = game.discard.pop();
      game.deck = shuffled(game.discard);
      game.discard = [top];
    }
    if (!game.deck.length) return i;
    game.hands[playerId].push(game.deck.pop());
  }
  return count;
}
function start(players, random = Math.random) {
  if (players.length < 2 || players.length > 10) throw new Error('UNO needs 2–10 players.');
  const game = {
    phase: 'playing',
    players,
    hands: {},
    deck: shuffled(deck(), random),
    discard: [],
    turn: 1,
    direction: 1,
    drawn: false,
    missedUno: null,
    winner: null,
  };
  for (const player of players) {
    game.hands[player.id] = [];
    drawCards(game, player.id, 7);
  }
  const topIndex = game.deck.findLastIndex((card) => card.value !== '+4');
  const [top] = game.deck.splice(topIndex, 1);
  game.deck = shuffled(game.deck, random);
  game.discard.push(top);
  game.color = top.color === 'wild' ? null : top.color;
  if (top.value === '+2') {
    drawCards(game, players[game.turn].id, 2);
    game.turn = next(game);
  }
  if (top.value === 'skip') game.turn = next(game);
  if (top.value === 'reverse') {
    game.direction = -1;
    game.turn = 0;
  }
  return game;
}
function playable(game, card, playerId) {
  if (!game.color) return false;
  if (card.value === '+4') return !game.hands[playerId].some((c) => c.color === game.color);
  return (
    card.color === 'wild' || card.color === game.color || card.value === game.discard.at(-1).value
  );
}
function assertTurn(game, playerId) {
  if (game.phase !== 'playing' || game.players[game.turn].id !== playerId)
    throw new Error('It is not your turn.');
}
function advance(game, steps = 1) {
  game.turn = next(game, steps);
  game.drawn = false;
}
function play(game, playerId, index, color, saysUno = false) {
  assertTurn(game, playerId);
  const hand = game.hands[playerId];
  if (!Number.isInteger(index) || index < 0 || index >= hand.length)
    throw new Error('Choose a valid card number from your private hand.');
  if (game.drawn && index !== hand.length - 1)
    throw new Error('After drawing, only the new card can be played.');
  const card = hand[index];
  if (!playable(game, card, playerId))
    throw new Error('That card cannot be played. +4 needs a hand without the active color.');
  if (card.color === 'wild' && !COLORS.includes(color))
    throw new Error('Choose red, yellow, green, or blue for a wild card.');
  game.missedUno = null;
  hand.splice(index, 1);
  game.discard.push(card);
  game.color = card.color === 'wild' ? color : card.color;
  if (hand.length === 1 && !saysUno) game.missedUno = playerId;
  let steps = 1;
  if (card.value === 'reverse') {
    game.direction *= -1;
    if (game.players.length === 2) steps = 2;
  }
  if (card.value === 'skip') steps = 2;
  if (['+2', '+4'].includes(card.value)) {
    drawCards(game, game.players[next(game)].id, card.value === '+2' ? 2 : 4);
    steps = 2;
  }
  if (!hand.length) {
    game.winner = playerId;
    game.phase = 'finished';
    return card;
  }
  advance(game, steps);
  return card;
}
function draw(game, playerId) {
  assertTurn(game, playerId);
  if (!game.color)
    throw new Error('Choose the opening wild color first: .uno color red|yellow|green|blue');
  if (game.drawn) throw new Error('You already drew. Play that card or use .uno pass.');
  game.missedUno = null;
  const drawn = drawCards(game, playerId, 1);
  if (!drawn) {
    advance(game);
    return;
  }
  game.drawn = true;
  if (!playable(game, game.hands[playerId].at(-1), playerId)) advance(game);
}
function pass(game, playerId) {
  assertTurn(game, playerId);
  if (!game.drawn) throw new Error('Draw a card first.');
  game.missedUno = null;
  advance(game);
}
function chooseColor(game, playerId, color) {
  assertTurn(game, playerId);
  if (game.color || !COLORS.includes(color))
    throw new Error('Only the first player chooses the opening wild color.');
  game.color = color;
}
function callUno(game, playerId) {
  if (game.hands[playerId]?.length !== 1)
    throw new Error('Call UNO when you have exactly one card.');
  if (game.missedUno === playerId) game.missedUno = null;
}
function catchUno(game, caller, target) {
  if (!game.hands[caller] || target === caller || game.missedUno !== target)
    throw new Error('Nobody eligible was caught missing UNO.');
  drawCards(game, target, 2);
  game.missedUno = null;
}
module.exports = {
  COLORS,
  shuffled,
  deck,
  start,
  play,
  draw,
  pass,
  chooseColor,
  callUno,
  catchUno,
  advance,
};
