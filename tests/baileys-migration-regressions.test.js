/**
 * Baileys migration regression tests — reaction identity + persona selection helpers.
 * Run: npx vitest run tests/baileys-migration-regressions.test.js
 */
import { describe, it, expect } from 'vitest';
import { normalizeReaction } from '../src/utils/aiReactions.js';

describe('Baileys reaction identity (real nested key shape)', () => {
  it('Test A: user reacts to AI message → fromMe false, reactor is user', () => {
    const event = {
      key: {
        id: 'AI_MSG_1',
        remoteJid: '2348012345678@s.whatsapp.net',
        fromMe: true, // target is bot message
      },
      reaction: {
        key: {
          id: 'USER_REACT_1',
          remoteJid: '2348012345678@s.whatsapp.net',
          fromMe: false, // reactor is the user
        },
        text: '❤️',
        timestamp: Date.now(),
      },
    };

    const n = normalizeReaction(event);
    expect(n.messageId).toBe('AI_MSG_1');
    expect(n.targetKey.fromMe).toBe(true);
    expect(n.fromMe).toBe(false);
    expect(n.emoji).toBe('❤️');
    expect(n.from).toBe('2348012345678@s.whatsapp.net');
  });

  it('Test B: bot reacts to its own message → fromMe true (skip own reaction)', () => {
    const event = {
      key: {
        id: 'AI_MSG_1',
        remoteJid: '2348012345678@s.whatsapp.net',
        fromMe: true,
      },
      reaction: {
        key: {
          id: 'BOT_REACT_1',
          remoteJid: '2348012345678@s.whatsapp.net',
          fromMe: true, // reactor is the bot
        },
        text: '😂',
        timestamp: Date.now(),
      },
    };

    const n = normalizeReaction(event);
    expect(n.messageId).toBe('AI_MSG_1');
    expect(n.fromMe).toBe(true);
    expect(n.emoji).toBe('😂');
  });

  it('group: reactor comes from nested participant, not target participant', () => {
    const event = {
      key: {
        id: 'AI_MSG_G',
        remoteJid: '120363@g.us',
        participant: 'bot@s.whatsapp.net',
        fromMe: true,
      },
      reaction: {
        key: {
          id: 'USER_REACT_G',
          remoteJid: '120363@g.us',
          participant: 'user@s.whatsapp.net',
          fromMe: false,
        },
        text: '🔥',
      },
    };
    const n = normalizeReaction(event);
    expect(n.from).toBe('user@s.whatsapp.net');
    expect(n.fromMe).toBe(false);
    expect(n.remoteJid).toBe('120363@g.us');
  });

  it('accepts legacy flattened emoji field without dropping reactor key', () => {
    const event = {
      key: { id: 'T1', remoteJid: 'chat@s.whatsapp.net', fromMe: true },
      reaction: {
        key: { id: 'R1', remoteJid: 'chat@s.whatsapp.net', fromMe: false },
        emoji: '👍',
      },
    };
    const n = normalizeReaction(event);
    expect(n.emoji).toBe('👍');
    expect(n.fromMe).toBe(false);
  });
});
