import { describe, it, expect } from 'vitest';
import {
  publicUser,
  leaderboardEntry,
  publicCard,
  publicOwnedCard,
  publicGuild,
  publicAuction,
} from '../src/api/serializers.js';

describe('api serializers', () => {
  it('publicUser whitelists public fields only', () => {
    const out = publicUser({
      id: '234@c.us',
      name: 'Bob',
      bio: 'hi',
      level: 3,
      xp: 250,
      coins: 500,
      orbs: 2,
      guildId: 'g1',
      tradesCompleted: 4,
      achievements: ['a', 'b'],
      cards: ['x'],
      createdAt: '2026-01-01',
      lastActiveAt: 123,
      loan: { amount: 999 },
      dob: '2000-01-01',
      warns: 2,
      bank: 100,
      stardust: 7,
    });
    expect(out).toEqual({
      id: '234@c.us',
      name: 'Bob',
      bio: 'hi',
      level: 3,
      xp: 250,
      coins: 500,
      orbs: 2,
      guildId: 'g1',
      tradesCompleted: 4,
      achievements: 2,
      cardCount: 1,
      createdAt: '2026-01-01',
      lastActiveAt: 123,
    });
    expect(out).not.toHaveProperty('loan');
    expect(out).not.toHaveProperty('dob');
    expect(out).not.toHaveProperty('warns');
    expect(out).not.toHaveProperty('bank');
  });

  it('leaderboardEntry adds the requested score', () => {
    const out = leaderboardEntry({ id: '1@c.us', name: 'A', coins: 42, xp: 10, level: 2 }, 'coins');
    expect(out.score).toBe(42);
  });

  it('publicCard maps catalogue fields and prefers renderedUrl', () => {
    const out = publicCard({
      cardId: 'ABC123',
      name: 'Rem',
      series: 'Re:Zero',
      aliases: ['rem'],
      tier: 'SS',
      imageUrl: 'u',
      renderedUrl: 'r',
      description: 'd',
      value: 900,
    });
    expect(out).toMatchObject({ cardId: 'ABC123', name: 'Rem', tier: 'SS', imageUrl: 'r', value: 900 });
  });

  it('publicOwnedCard maps owned card fields', () => {
    const out = publicOwnedCard({
      _id: '507f1f77bcf86cd799439011',
      code: 'XYZ',
      name: 'Rem',
      series: 'Re:Zero',
      tier: 'SS',
      isForSale: true,
      price: 100,
      timesTraded: 2,
    });
    expect(out).toMatchObject({ code: 'XYZ', name: 'Rem', isForSale: true, price: 100 });
    expect(out.id).toBe('507f1f77bcf86cd799439011');
  });

  it('publicGuild summarizes the member list', () => {
    const out = publicGuild({ guildId: 7, name: 'Tempest', members: [{}, {}, {}], level: 5, bank: 1000 });
    expect(out.memberCount).toBe(3);
    expect(out.guildId).toBe(7);
  });

  it('publicAuction maps auction fields', () => {
    const out = publicAuction({
      _id: 'abc',
      cardName: 'Rem',
      cardTier: 'SS',
      startPrice: 50,
      currentBid: 80,
      endsAt: '2026-12-01',
    });
    expect(out).toMatchObject({ cardName: 'Rem', currentBid: 80, startPrice: 50 });
  });

  it('serializers return null for null input', () => {
    expect(publicUser(null)).toBeNull();
    expect(publicCard(null)).toBeNull();
    expect(publicGuild(null)).toBeNull();
    expect(publicAuction(null)).toBeNull();
    expect(publicOwnedCard(null)).toBeNull();
  });
});
