// Battle bot decision-making — attack vs defend.
//
// Unlike chess/tictactoe/connect4 (deterministic games with a searchable
// move tree), Battle's core mechanic is inherently random — every attack
// rolls rand(10, 35) damage and every defend rolls rand(5, 15) healed (see
// battle.js) — so there's no fixed-outcome tree for minimax/alpha-beta to
// search the way the other three engines do. Instead this is a
// difficulty-tuned heuristic over the bot's own HP and the opponent's HP:
// how low does the bot's HP need to be before it starts playing
// defensively, and how consistently does it actually do so.

const DECISION = {
  // Almost always attacks, and only rarely plays defensively even when
  // badly hurt — an easy opponent that mostly just trades blows.
  easy:   { defendThreshold: 20, defendChance: 0.15 },
  // Starts favoring defense once under about a third of its HP.
  medium: { defendThreshold: 35, defendChance: 0.45 },
  // Defends reliably once hurt, making it a war of attrition to bring down.
  hard:   { defendThreshold: 50, defendChance: 0.80 },
};

/**
 * @param {number} botHp - the bot's own current HP (0-100).
 * @param {number} opponentHp - the human's current HP (0-100).
 * @param {'easy'|'medium'|'hard'} [difficulty='medium']
 * @returns {'attack'|'defend'}
 */
function chooseAction(botHp, opponentHp, difficulty = 'medium') {
  const { defendThreshold, defendChance } = DECISION[difficulty] || DECISION.medium;

  // Always go for the kill once the opponent is low enough that even a
  // below-average attack roll (attack's floor is 10) could plausibly
  // finish them — defending instead would just be wasting the turn.
  if (opponentHp <= 35) return 'attack';

  if (botHp <= defendThreshold && Math.random() < defendChance) return 'defend';
  return 'attack';
}

module.exports = { chooseAction };
