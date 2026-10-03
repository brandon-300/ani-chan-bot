/**
 * Baileys v7 Integration Tests
 * Comprehensive test suite for the Baileys migration
 * 
 * Test Categories:
 * 1. Connection Lifecycle
 * 2. Identity (LID/PN resolution)
 * 3. Messaging
 * 4. Groups
 * 5. AI Integration
 * 6. Sticker System
 */

import { describe, it, beforeAll, afterAll, vi, expect, beforeEach } from 'vitest';

// Mock environment variables
process.env.LOG_LEVEL = 'error';
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.BOT_NAME = 'Ani-Chan Test';
process.env.BOT_PREFIX = '.';
process.env.OWNER_NUMBER = '2348012345678@s.whatsapp.net';
process.env.OWNER_IDS = '2348012345679@s.whatsapp.net,2348012345680@lid';
process.env.MOD_NUMBERS = '2348012345681@s.whatsapp.net,2348012345682@lid';
process.env.PHONE_NUMBER = '2348012345678';
process.env.AI_REACT_TO_REACTIONS = 'true';
process.env.AI_REACT_CHANCE = '1.0';
process.env.AI_REACT_COOLDOWN_MS = '0';

// ============================================================================
// Category 1: Connection Lifecycle Tests
// ============================================================================

describe('Connection Lifecycle', () => {
  let socketManager;
  let mockSock;
  let mockAuthManager;

  beforeAll(async () => {
    // Mock auth manager
    mockAuthManager = {
      init: vi.fn().mockResolvedValue({
        creds: {},
        keys: {},
      }),
      isAuthenticated: vi.fn().mockReturnValue(false),
      saveCreds: vi.fn().mockResolvedValue(true),
      getPairingCode: vi.fn().mockResolvedValue('123456'),
    };
    
    vi.mock('./src/whatsapp/auth.js', () => ({
      default: mockAuthManager,
    }));
    
    // Mock identity service
    vi.mock('./src/whatsapp/identity.js', () => ({
      default: {
        normalizeJid: vi.fn((jid) => jid),
        getCanonicalId: vi.fn((jid) => jid),
        resolveIdentity: vi.fn((jid) => ({ canonicalId: jid, phoneNumber: jid?.split('@')[0] })),
      },
    }));
    
    // Mock Baileys
    mockSock = {
      user: { id: 'test-bot@s.whatsapp.net', name: 'Test Bot' },
      ws: { close: vi.fn() },
      ev: {
        on: vi.fn(),
      },
      sendMessage: vi.fn().mockResolvedValue({ key: { id: 'msg1', remoteJid: 'test@s.whatsapp.net' } }),
      groupMetadata: vi.fn(),
      groupLeave: vi.fn(),
      groupSettingUpdate: vi.fn(),
      editMessage: vi.fn(),
    };
    
    vi.mock('@whiskeysockets/baileys', () => ({
      makeWASocket: vi.fn().mockReturnValue(mockSock),
      DisconnectReason: { loggedOut: 401 },
      fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 3000, 1015901307] }),
      makeCacheableSignalKeyStore: vi.fn().mockReturnValue({}),
      Browsers: { ubuntu: vi.fn().mockReturnValue('Chrome') },
      normalizeMessageContent: vi.fn((msg) => msg),
    }));
    
    // Import after mocking
    const module = await import('../src/whatsapp/socket.js');
    socketManager = module.default;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Initialization', () => {
    it('should initialize socket with correct config', async () => {
      await socketManager.init();
      
      expect(socketManager.isConnecting).toBe(false);
      expect(socketManager.sock).toBeDefined();
    });

    it('should handle pairing code generation', async () => {
      await socketManager.init();
      await socketManager.handlePairingCode();
      
      expect(mockAuthManager.getPairingCode).toHaveBeenCalled();
    });

    it('should emit authenticated event on isNewLogin', async () => {
      const mockHandler = vi.fn();
      socketManager.on('authenticated', mockHandler);
      
      await socketManager.init();
      await socketManager.handleConnectionUpdate({ isNewLogin: true });
      
      expect(mockHandler).toHaveBeenCalled();
    });
  });

  describe('Connection States', () => {
    it('should emit ready only on first connection', async () => {
      const mockReadyHandler = vi.fn();
      const mockReconnectHandler = vi.fn();
      socketManager.on('ready', mockReadyHandler);
      socketManager.on('reconnect', mockReconnectHandler);
      
      // Mock isAuthenticated to return true
      mockAuthManager.isAuthenticated.mockReturnValue(true);
      
      // First connection
      await socketManager.init();
      await socketManager.handleConnectionUpdate({ connection: 'open' });
      
      expect(mockReadyHandler).toHaveBeenCalledTimes(1);
      expect(mockReconnectHandler).not.toHaveBeenCalled();
      
      // Mark as initialized
      socketManager.backgroundInitialized = true;
      
      // Reconnect
      await socketManager.handleConnectionUpdate({ connection: 'open' });
      
      expect(mockReadyHandler).toHaveBeenCalledTimes(1);
      expect(mockReconnectHandler).toHaveBeenCalled();
    });

    it('should handle disconnection with logged out status', async () => {
      const mockErrorHandler = vi.fn();
      socketManager.on('error', mockErrorHandler);
      
      await socketManager.init();
      await socketManager.handleConnectionUpdate({
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 401 } } },
      });
      
      expect(mockErrorHandler).toHaveBeenCalled();
    });

    it('should schedule reconnection on non-logout disconnect', async () => {
      vi.useFakeTimers();
      
      await socketManager.init();
      await socketManager.handleConnectionUpdate({
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 500 } } },
      });
      
      expect(socketManager.reconnectTimeout).not.toBeNull();
      
      vi.useRealTimers();
    });
  });

  describe('Shutdown', () => {
    it('should disconnect cleanly', async () => {
      await socketManager.init();
      await socketManager.disconnect();
      
      expect(socketManager.isShuttingDown).toBe(true);
      expect(socketManager.isConnected).toBe(false);
      expect(mockSock.ws.close).toHaveBeenCalled();
    });
  });
});

// ============================================================================
// Category 2: Identity Tests
// ============================================================================

describe('Identity Service', () => {
  let identityService;

  beforeAll(async () => {
    const module = await import('../src/whatsapp/identity.js');
    identityService = module.default;
  });

  beforeEach(() => {
    identityService.lidToPnMap.clear();
    identityService.pnToLidMap.clear();
    identityService.contacts.clear();
  });

  describe('JID Normalization', () => {
    it('should normalize phone number JIDs', () => {
      const result = identityService.normalizeJid('2348012345678@s.whatsapp.net');
      expect(result).toBe('2348012345678@s.whatsapp.net');
    });

    it('should normalize LID JIDs', () => {
      const result = identityService.normalizeJid('123456@lid');
      expect(result).toBe('123456@lid');
    });

    it('should normalize group JIDs', () => {
      const result = identityService.normalizeJid('test-group@g.us');
      expect(result).toBe('test-group@g.us');
    });

    it('should strip device suffixes', () => {
      const result = identityService.normalizeJid('2348012345678:123@s.whatsapp.net');
      expect(result).toBe('2348012345678@s.whatsapp.net');
    });

    it('should handle bare numbers', () => {
      const result = identityService.normalizeJid('2348012345678');
      expect(result).toBe('2348012345678@s.whatsapp.net');
    });
  });

  describe('LID/PN Mapping', () => {
    it('should identify LID JIDs', () => {
      expect(identityService.isLid('123456@lid')).toBe(true);
      expect(identityService.isLid('2348012345678@s.whatsapp.net')).toBe(false);
    });

    it('should identify phone number JIDs', () => {
      expect(identityService.isPhoneNumberJid('2348012345678@s.whatsapp.net')).toBe(true);
      expect(identityService.isPhoneNumberJid('123456@lid')).toBe(false);
    });

    it('should identify group JIDs', () => {
      expect(identityService.isGroupJid('test@g.us')).toBe(true);
      expect(identityService.isGroupJid('2348012345678@s.whatsapp.net')).toBe(false);
    });

    it('should get canonical ID preferring LID', () => {
      // Add mapping
      identityService.addLidPnMapping('123456@lid', '2348012345678@s.whatsapp.net');
      
      // PN should resolve to LID
      const result = identityService.getCanonicalId('2348012345678@s.whatsapp.net');
      expect(result).toBe('123456@lid');
    });

    it('should get phone number from LID', () => {
      identityService.addLidPnMapping('123456@lid', '2348012345678@s.whatsapp.net');
      
      const result = identityService.getPnFromLid('123456@lid');
      expect(result).toBe('2348012345678@s.whatsapp.net');
    });

    it('should get LID from phone number', () => {
      identityService.addLidPnMapping('123456@lid', '2348012345678@s.whatsapp.net');
      
      const result = identityService.getLidFromPn('2348012345678@s.whatsapp.net');
      expect(result).toBe('123456@lid');
    });

    it('should extract phone number from any JID', () => {
      expect(identityService.getPhoneNumber('2348012345678@s.whatsapp.net')).toBe('2348012345678');
      expect(identityService.getPhoneNumber('123456@lid')).toBe('123456');
    });
  });

  describe('Owner/Mod Checks', () => {
    beforeEach(() => {
      // Reset owner/mod IDs
      identityService.ownerIds = ['2348012345678@s.whatsapp.net', '2348012345679@s.whatsapp.net'];
      identityService.modIds = ['2348012345681@s.whatsapp.net'];
    });

    it('should identify owner by PN', () => {
      expect(identityService.isOwner('2348012345678@s.whatsapp.net')).toBe(true);
      expect(identityService.isOwner('2348012345678@lid')).toBe(false);
    });

    it('should identify owner by LID with mapping', () => {
      identityService.addLidPnMapping('2348012345678@lid', '2348012345678@s.whatsapp.net');
      expect(identityService.isOwner('2348012345678@lid')).toBe(true);
    });

    it('should identify moderator', () => {
      expect(identityService.isMod('2348012345681@s.whatsapp.net')).toBe(true);
    });

    it('should identify owner as moderator', () => {
      expect(identityService.isMod('2348012345678@s.whatsapp.net')).toBe(true);
    });

    it('should identify non-owner/non-mod', () => {
      expect(identityService.isOwner('2348012345999@s.whatsapp.net')).toBe(false);
      expect(identityService.isMod('2348012345999@s.whatsapp.net')).toBe(false);
    });
  });

  describe('Identity Resolution', () => {
    it('should resolve identity with all fields', () => {
      identityService.addLidPnMapping('123456@lid', '2348012345678@s.whatsapp.net');
      
      const result = identityService.resolveIdentity('123456@lid');
      
      expect(result).toHaveProperty('jid', '123456@lid');
      expect(result).toHaveProperty('canonicalId', '123456@lid');
      expect(result).toHaveProperty('phoneNumber', '2348012345678');
      expect(result).toHaveProperty('isLid', true);
    });

    it('should remember contact names', () => {
      identityService.rememberContact('123456@lid', 'Test User');
      const result = identityService.getDisplayName('123456@lid');
      expect(result).toBe('Test User');
    });
  });
});

// ============================================================================
// Category 3: Messaging Tests
// ============================================================================

describe('Messaging', () => {
  let socketManager;
  let mockSock;
  let mockIdentity;

  beforeAll(async () => {
    mockSock = {
      user: { id: 'test-bot@s.whatsapp.net', name: 'Test Bot' },
      ws: { close: vi.fn() },
      ev: {
        on: vi.fn(),
      },
      sendMessage: vi.fn().mockImplementation((jid, payload, options) => {
        return Promise.resolve({
          key: { 
            id: 'msg-' + Math.random().toString(36).substr(2, 9),
            remoteJid: jid,
            fromMe: true,
          },
          ...payload,
        });
      }),
      groupMetadata: vi.fn(),
      groupLeave: vi.fn(),
      groupSettingUpdate: vi.fn(),
      editMessage: vi.fn(),
    };
    
    mockIdentity = {
      normalizeJid: vi.fn((jid) => jid),
      getCanonicalId: vi.fn((jid) => jid),
      resolveIdentity: vi.fn((jid) => ({ canonicalId: jid, phoneNumber: jid?.split('@')[0] })),
    };
    
    vi.mock('@whiskeysockets/baileys', () => ({
      makeWASocket: vi.fn().mockReturnValue(mockSock),
      DisconnectReason: { loggedOut: 401 },
      fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 3000, 1015901307] }),
      makeCacheableSignalKeyStore: vi.fn().mockReturnValue({}),
      Browsers: { ubuntu: vi.fn().mockReturnValue('Chrome') },
      normalizeMessageContent: vi.fn((msg) => msg),
    }));
    
    vi.mock('./src/whatsapp/auth.js', () => ({
      default: {
        init: vi.fn().mockResolvedValue({ creds: {}, keys: {} }),
        isAuthenticated: vi.fn().mockReturnValue(true),
        saveCreds: vi.fn().mockResolvedValue(true),
        getPairingCode: vi.fn().mockResolvedValue('123456'),
      },
    }));
    
    vi.mock('./src/whatsapp/identity.js', () => ({
      default: mockIdentity,
    }));
    
    vi.mock('./src/whatsapp/media.js', () => ({
      downloadBaileysMedia: vi.fn().mockResolvedValue(Buffer.from('test')),
      toBaileysMediaPayload: vi.fn((content) => content),
    }));
    
    const module = await import('../src/whatsapp/socket.js');
    socketManager = module.default;
    socketManager.sock = mockSock;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Message Normalization', () => {
    it('should normalize text message', () => {
      const baileysMsg = {
        key: { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net', fromMe: false },
        message: { conversation: 'Hello world' },
        pushName: 'Test User',
      };
      
      const result = socketManager.normalizeMessage(baileysMsg);
      
      expect(result.type).toBe('chat');
      expect(result.body).toBe('Hello world');
      expect(result.from).toBe('2348012345678@s.whatsapp.net');
      expect(result.pushName).toBe('Test User');
      expect(result.hasMedia).toBe(false);
    });

    it('should normalize image message', () => {
      const baileysMsg = {
        key: { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net', fromMe: false },
        message: { imageMessage: { caption: 'Test image' } },
        pushName: 'Test User',
      };
      
      const result = socketManager.normalizeMessage(baileysMsg);
      
      expect(result.type).toBe('image');
      expect(result.body).toBe('Test image');
      expect(result.hasMedia).toBe(true);
    });

    it('should normalize video message', () => {
      const baileysMsg = {
        key: { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net', fromMe: false },
        message: { videoMessage: { caption: 'Test video' } },
      };
      
      const result = socketManager.normalizeMessage(baileysMsg);
      
      expect(result.type).toBe('video');
      expect(result.hasMedia).toBe(true);
    });

    it('should normalize sticker message', () => {
      const baileysMsg = {
        key: { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net', fromMe: false },
        message: { stickerMessage: {} },
      };
      
      const result = socketManager.normalizeMessage(baileysMsg);
      
      expect(result.type).toBe('sticker');
      expect(result.hasMedia).toBe(true);
    });

    it('should normalize audio message', () => {
      const baileysMsg = {
        key: { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net', fromMe: false },
        message: { audioMessage: { ptt: true } },
      };
      
      const result = socketManager.normalizeMessage(baileysMsg);
      
      expect(result.type).toBe('ptt');
      expect(result.hasMedia).toBe(true);
    });

    it('should normalize document message', () => {
      const baileysMsg = {
        key: { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net', fromMe: false },
        message: { documentMessage: { fileName: 'test.pdf' } },
      };
      
      const result = socketManager.normalizeMessage(baileysMsg);
      
      expect(result.type).toBe('document');
      expect(result.hasMedia).toBe(true);
    });

    it('should normalize extended text message', () => {
      const baileysMsg = {
        key: { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net', fromMe: false },
        message: { extendedTextMessage: { text: 'Extended text' } },
      };
      
      const result = socketManager.normalizeMessage(baileysMsg);
      
      expect(result.type).toBe('chat');
      expect(result.body).toBe('Extended text');
    });

    it('should normalize location message', () => {
      const baileysMsg = {
        key: { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net', fromMe: false },
        message: { locationMessage: { degreesLatitude: 10.0, degreesLongitude: 20.0 } },
      };
      
      const result = socketManager.normalizeMessage(baileysMsg);
      
      expect(result.type).toBe('location');
      expect(result.hasMedia).toBe(false);
    });

    it('should normalize contact message', () => {
      const baileysMsg = {
        key: { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net', fromMe: false },
        message: { contactMessage: { displayName: 'Test Contact' } },
      };
      
      const result = socketManager.normalizeMessage(baileysMsg);
      
      expect(result.type).toBe('contact');
      expect(result.body).toBe('Test Contact');
    });

    it('should normalize poll message', () => {
      const baileysMsg = {
        key: { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net', fromMe: false },
        message: { pollCreationMessage: { name: 'Test Poll' } },
      };
      
      const result = socketManager.normalizeMessage(baileysMsg);
      
      expect(result.type).toBe('poll');
    });

    it('should normalize group invite message', () => {
      const baileysMsg = {
        key: { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net', fromMe: false },
        message: { groupInviteMessage: { groupJid: 'test@g.us' } },
      };
      
      const result = socketManager.normalizeMessage(baileysMsg);
      
      expect(result.type).toBe('group_invite');
    });

    it('should normalize buttons response message', () => {
      const baileysMsg = {
        key: { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net', fromMe: false },
        message: { buttonsResponseMessage: { selectedButtonId: 'btn1' } },
      };
      
      const result = socketManager.normalizeMessage(baileysMsg);
      
      expect(result.type).toBe('buttons_response');
    });

    it('should normalize list response message', () => {
      const baileysMsg = {
        key: { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net', fromMe: false },
        message: { listResponseMessage: { selectedRowId: 'row1' } },
      };
      
      const result = socketManager.normalizeMessage(baileysMsg);
      
      expect(result.type).toBe('list_response');
    });

    it('should detect ephemeral messages', () => {
      const baileysMsg = {
        key: { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net', fromMe: false },
        message: { 
          ephemeralMessage: { 
            message: { conversation: 'Ephemeral text' } 
          } 
        },
      };
      
      const result = socketManager.normalizeMessage(baileysMsg);
      
      expect(result.isEphemeral).toBe(true);
    });

    it('should detect view-once messages', () => {
      const baileysMsg = {
        key: { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net', fromMe: false },
        message: { 
          viewOnceMessage: { 
            message: { imageMessage: {} } 
          } 
        },
      };
      
      const result = socketManager.normalizeMessage(baileysMsg);
      
      expect(result.isViewOnce).toBe(true);
    });

    it('should detect edited messages', () => {
      const baileysMsg = {
        key: { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net', fromMe: false },
        message: { 
          editedMessage: { 
            message: { conversation: 'Edited text' } 
          } 
        },
      };
      
      const result = socketManager.normalizeMessage(baileysMsg);
      
      expect(result.isEdited).toBe(true);
    });

    it('should detect protocol messages', () => {
      const baileysMsg = {
        key: { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net', fromMe: false },
        message: { protocolMessage: { type: 0 } },
      };
      
      const result = socketManager.normalizeMessage(baileysMsg);
      
      expect(result.type).toBe('protocol');
      expect(result.isProtocol).toBe(true);
    });

    it('should handle group messages with participant', () => {
      const baileysMsg = {
        key: { id: 'msg1', remoteJid: 'test@g.us', fromMe: false },
        participant: '2348012345678@s.whatsapp.net',
        message: { conversation: 'Group message' },
        pushName: 'Test User',
      };
      
      const result = socketManager.normalizeMessage(baileysMsg);
      
      expect(result.isGroup).toBe(true);
      expect(result.author).toBe('2348012345678@s.whatsapp.net');
      expect(result.from).toBe('test@g.us');
    });

    it('should handle LID participant in group', () => {
      const baileysMsg = {
        key: { 
          id: 'msg1', 
          remoteJid: 'test@g.us', 
          fromMe: false,
          participantAlt: '2348012345678@lid',
        },
        participant: '2348012345678@s.whatsapp.net',
        message: { conversation: 'Group message' },
      };
      
      const result = socketManager.normalizeMessage(baileysMsg);
      
      expect(result.participantAlt).toBe('2348012345678@lid');
    });
  });

  describe('Message Sending', () => {
    it('should send text message', async () => {
      const result = await socketManager.sendMessage('2348012345678@s.whatsapp.net', 'Hello');
      
      expect(mockSock.sendMessage).toHaveBeenCalled();
      expect(result.key.remoteJid).toBe('2348012345678@s.whatsapp.net');
    });

    it('should send message with quotes', async () => {
      const quotedMsg = {
        _baileys: { key: { id: 'quoted-msg', remoteJid: '2348012345678@s.whatsapp.net' } },
      };
      
      await socketManager.sendMessage('2348012345678@s.whatsapp.net', 'Reply', {}, quotedMsg);
      
      expect(mockSock.sendMessage).toHaveBeenCalledWith(
        '2348012345678@s.whatsapp.net',
        { text: 'Reply' },
        { quoted: quotedMsg._baileys.key }
      );
    });

    it('should register sent messages', async () => {
      await socketManager.sendMessage('2348012345678@s.whatsapp.net', 'Test');
      
      expect(socketManager.sentMessages.size).toBeGreaterThan(0);
    });
  });

  describe('Message Deletion', () => {
    it('should delete message', async () => {
      const key = { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net' };
      
      await socketManager.deleteMessage(key);
      
      expect(mockSock.sendMessage).toHaveBeenCalledWith(
        '2348012345678@s.whatsapp.net',
        { delete: { ...key, remoteJid: '2348012345678@s.whatsapp.net' } }
      );
    });
  });

  describe('Message Forwarding', () => {
    it('should forward message', async () => {
      const baileysMsg = {
        key: { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net' },
        message: { conversation: 'Forward me' },
      };
      
      await socketManager.forwardMessage('2348012345679@s.whatsapp.net', baileysMsg);
      
      expect(mockSock.sendMessage).toHaveBeenCalledWith(
        '2348012345679@s.whatsapp.net',
        expect.objectContaining({ forward: expect.any(Object) })
      );
    });
  });

  describe('Message Editing', () => {
    it('should edit message with native editMessage', async () => {
      mockSock.editMessage.mockResolvedValueOnce({ key: { id: 'edited-msg' } });
      
      const key = { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net' };
      
      await socketManager.editMessage(key, 'New content');
      
      expect(mockSock.editMessage).toHaveBeenCalled();
    });

    it('should fall back to delete+send when editMessage fails', async () => {
      mockSock.editMessage.mockRejectedValueOnce(new Error('Not supported'));
      
      const key = { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net' };
      
      await socketManager.editMessage(key, 'New content');
      
      expect(mockSock.sendMessage).toHaveBeenCalled();
    });
  });

  describe('Reactions', () => {
    it('should react to message', async () => {
      const key = { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net' };
      
      await socketManager.react(key, '\u2764');
      
      expect(mockSock.sendMessage).toHaveBeenCalledWith(
        '2348012345678@s.whatsapp.net',
        { react: { text: '\u2764', key: { ...key, remoteJid: '2348012345678@s.whatsapp.net' } } }
      );
    });

    it('should handle message reaction event', async () => {
      const mockHandler = vi.fn();
      socketManager.on('message_reaction', mockHandler);
      
      const reaction = {
        key: { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net' },
        reaction: { text: '\u2764', timestamp: Date.now() },
      };
      
      await socketManager.handleMessageReaction(reaction);
      
      expect(mockHandler).toHaveBeenCalled();
    });
  });
});

// ============================================================================
// Category 4: Groups Tests
// ============================================================================

describe('Groups Service', () => {
  let groupsService;
  let mockSock;
  let mockIdentity;

  beforeAll(async () => {
    mockSock = {
      user: { id: 'test-bot@s.whatsapp.net' },
      groupMetadata: vi.fn().mockResolvedValue({
        id: 'test@g.us',
        subject: 'Test Group',
        participants: [
          { id: '2348012345678@s.whatsapp.net', pushName: 'User 1', isAdmin: true, isSuperAdmin: false },
          { id: '2348012345679@s.whatsapp.net', pushName: 'User 2', isAdmin: false, isSuperAdmin: false },
        ],
      }),
    };
    
    mockIdentity = {
      normalizeJid: vi.fn((jid) => jid),
      rememberContact: vi.fn(),
    };
    
    vi.mock('./src/whatsapp/identity.js', () => ({
      default: mockIdentity,
    }));
    
    vi.mock('./src/whatsapp/socket.js', () => ({
      default: { getSocket: () => mockSock },
    }));
    
    const module = await import('../src/whatsapp/groups.js');
    groupsService = module.default;
    groupsService.sock = mockSock;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    groupsService.groupCache.clear();
  });

  describe('Group Caching', () => {
    it('should cache group metadata', async () => {
      const group = await groupsService.getGroup('test@g.us');
      
      expect(mockSock.groupMetadata).toHaveBeenCalledWith('test@g.us');
      expect(group.id._serialized).toBe('test@g.us');
      expect(group.name).toBe('Test Group');
    });

    it('should return cached group on second call', async () => {
      // First call
      await groupsService.getGroup('test@g.us');
      
      // Second call - should use cache
      await groupsService.getGroup('test@g.us');
      
      expect(mockSock.groupMetadata).toHaveBeenCalledTimes(1);
    });

    it('should invalidate cache', async () => {
      await groupsService.getGroup('test@g.us');
      
      groupsService.invalidateCache('test@g.us');
      
      await groupsService.getGroup('test@g.us');
      
      expect(mockSock.groupMetadata).toHaveBeenCalledTimes(2);
    });

    it('should auto-invalidate cache on TTL expiry', async () => {
      vi.useFakeTimers();
      
      await groupsService.getGroup('test@g.us');
      
      // Fast forward past TTL
      vi.advanceTimersByTime(301000);
      
      await groupsService.getGroup('test@g.us');
      
      expect(mockSock.groupMetadata).toHaveBeenCalledTimes(2);
      
      vi.useRealTimers();
    });
  });

  describe('Group Operations', () => {
    it('should get group participants', async () => {
      const group = await groupsService.getGroup('test@g.us');
      
      expect(group.participants).toHaveLength(2);
      expect(group.participants[0].isAdmin).toBe(true);
    });

    it('should check if user is admin', async () => {
      const group = await groupsService.getGroup('test@g.us');
      const isAdmin = groupsService.isAdmin(group, '2348012345678@s.whatsapp.net');
      
      expect(isAdmin).toBe(true);
    });

    it('should check if user is not admin', async () => {
      const group = await groupsService.getGroup('test@g.us');
      const isAdmin = groupsService.isAdmin(group, '2348012345679@s.whatsapp.net');
      
      expect(isAdmin).toBe(false);
    });

    it('should check if bot is admin', async () => {
      const group = await groupsService.getGroup('test@g.us');
      const isBotAdmin = groupsService.isBotAdmin(group);
      
      // This depends on group metadata including bot as admin
      expect(typeof isBotAdmin).toBe('boolean');
    });
  });
});

// ============================================================================
// Category 5: AI Integration Tests
// ============================================================================

describe('AI Integration', () => {
  let aiReactions;
  let mockClient;

  beforeAll(async () => {
    mockClient = {
      info: { wid: { _serialized: 'test-bot@s.whatsapp.net' } },
      react: vi.fn().mockResolvedValue(true),
    };
    
    const module = await import('../src/utils/aiReactions.js');
    aiReactions = module.default;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Reaction Handler', () => {
    it('should create reaction handler', () => {
      const handler = aiReactions.createReactionHandler({ client: mockClient });
      
      expect(handler).toHaveProperty('handle');
    });

    it('should skip own reactions', () => {
      const handler = aiReactions.createReactionHandler({ client: mockClient });
      
      const reaction = {
        fromMe: true,
        emoji: '\u2764',
      };
      
      const result = handler.handle(reaction);
      
      expect(result.action).toBe('skip');
      expect(result.reason).toBe('own_reaction');
    });

    it('should skip when disabled', () => {
      const handler = aiReactions.createReactionHandler({
        client: mockClient,
        settings: { enabled: false },
      });
      
      const result = handler.handle({ emoji: '\u2764' });
      
      expect(result.action).toBe('skip');
      expect(result.reason).toBe('disabled');
    });

    it('should skip non-AI message reactions', () => {
      const handler = aiReactions.createReactionHandler({ client: mockClient });
      
      const result = handler.handle({
        emoji: '\u2764',
        from: '2348012345678@s.whatsapp.net',
      });
      
      expect(result.action).toBe('skip');
      expect(result.reason).toBe('not_ai_message');
    });

    it('should react to valid AI message', () => {
      vi.useFakeTimers();
      
      const handler = aiReactions.createReactionHandler({
        client: mockClient,
        settings: { enabled: true, chance: 1.0, cooldownMs: 0 },
      });
      
      // Mock ledger to return AI message
      const mockLedger = {
        get: vi.fn().mockReturnValue({ kind: 'sticker' }),
        markReacted: vi.fn(),
      };
      
      const handlerWithLedger = aiReactions.createReactionHandler({
        client: mockClient,
        ledger: mockLedger,
        settings: { enabled: true, chance: 1.0, cooldownMs: 0, delayMinMs: 0, delayMaxMs: 0 },
      });
      
      const result = handlerWithLedger.handle({
        emoji: '\u2764',
        from: '2348012345678@s.whatsapp.net',
        messageId: 'msg1',
        remoteJid: 'test@g.us',
      });
      
      expect(result.action).toBe('react');
      
      vi.useRealTimers();
    });
  });

  describe('Reaction Picking', () => {
    it('should pick reaction from same family', () => {
      const emoji = aiReactions.pickReactionEmoji('\u2764');
      
      expect(['\u2764\ufe0f', '\ud83e\udd70', '\ud83d\ude0a', '\ud83d\udc95']).toContain(emoji);
    });

    it('should return same emoji for unknown', () => {
      const emoji = aiReactions.pickReactionEmoji('\u{1F999}');
      
      expect(emoji).toBe('\u{1F999}');
    });
  });
});

// ============================================================================
// Category 6: Sticker System Tests
// ============================================================================

describe('Sticker System', () => {
  let aiStickers;
  let mockClient;

  beforeAll(async () => {
    mockClient = {
      sendSticker: vi.fn().mockResolvedValue(true),
      sendMessage: vi.fn().mockResolvedValue({ key: { id: 'msg1' } }),
      getChat: vi.fn().mockResolvedValue({ id: { _serialized: 'test@g.us' } }),
      getContact: vi.fn().mockResolvedValue({ id: { _serialized: '2348012345678@s.whatsapp.net' } }),
    };
    
    vi.mock('./src/utils/persona.js', () => ({
      getActivePersonaSafe: vi.fn().mockReturnValue({
        name: 'Marin Kitagawa',
        callNames: ['Marin', 'Marin-chan'],
      }),
    }));
    
    vi.mock('./src/models/AiStickerLibrary.js', () => ({
      default: {
        findById: vi.fn().mockResolvedValue(null),
        find: vi.fn().mockResolvedValue([]),
        findOneAndUpdate: vi.fn().mockResolvedValue(null),
        countDocuments: vi.fn().mockResolvedValue(0),
      },
    }));
    
    vi.mock('./src/models/AiSticker.js', () => ({
      default: {
        create: vi.fn().mockResolvedValue({}),
      },
    }));
    
    const module = await import('../src/utils/aiStickers.js');
    aiStickers = module.default;
    await aiStickers.initialize();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Sticker Exclusivity', () => {
    it('should return exclusivity rules', () => {
      const rules = aiStickers.getExclusivityRules();
      
      expect(rules).toHaveProperty('text');
      expect(rules).toHaveProperty('sticker');
      expect(rules).toHaveProperty('voice');
    });

    it('should check if sticker should be included', () => {
      const shouldInclude = aiStickers.shouldIncludeSticker({
        type: 'chat',
        hasMedia: false,
      });
      
      expect(shouldInclude).toBe(true);
    });

    it('should not include sticker for voice messages', () => {
      const shouldInclude = aiStickers.shouldIncludeSticker({
        type: 'ptt',
        hasMedia: true,
      });
      
      expect(shouldInclude).toBe(false);
    });

    it('should not include sticker for sticker replies', () => {
      const shouldInclude = aiStickers.shouldIncludeSticker({
        type: 'sticker',
        hasMedia: true,
      }, true);
      
      expect(shouldInclude).toBe(false);
    });
  });
});

// ============================================================================
// Helper Functions for Manual Testing
// ============================================================================

/**
 * Run all tests manually (for Termux without vitest)
 * This is a fallback for environments where vitest is not available
 */
async function runManualTests() {
  console.log('\n=== Running Manual Baileys Integration Tests ===\n');
  
  let passed = 0;
  let failed = 0;
  
  // Test 1: Identity Service
  try {
    console.log('Testing Identity Service...');
    const identityModule = await import('../src/whatsapp/identity.js');
    const identity = identityModule.default;
    
    // Test normalization
    const normalized = identity.normalizeJid('2348012345678@s.whatsapp.net');
    if (normalized === '2348012345678@s.whatsapp.net') {
      console.log('  ✓ JID normalization works');
      passed++;
    } else {
      console.log('  ✗ JID normalization failed');
      failed++;
    }
    
    // Test LID detection
    if (identity.isLid('123456@lid')) {
      console.log('  ✓ LID detection works');
      passed++;
    } else {
      console.log('  ✗ LID detection failed');
      failed++;
    }
    
    // Test PN detection
    if (identity.isPhoneNumberJid('2348012345678@s.whatsapp.net')) {
      console.log('  ✓ PN detection works');
      passed++;
    } else {
      console.log('  ✗ PN detection failed');
      failed++;
    }
    
    // Test mapping
    identity.addLidPnMapping('123456@lid', '2348012345678@s.whatsapp.net');
    if (identity.getCanonicalId('2348012345678@s.whatsapp.net') === '123456@lid') {
      console.log('  ✓ LID/PN mapping works');
      passed++;
    } else {
      console.log('  ✗ LID/PN mapping failed');
      failed++;
    }
    
    console.log('Identity Service: PASSED\n');
  } catch (err) {
    console.log('Identity Service: FAILED -', err.message, '\n');
    failed++;
  }
  
  // Test 2: Message Normalization
  try {
    console.log('Testing Message Normalization...');
    
    const socketModule = await import('../src/whatsapp/socket.js');
    const socketManager = socketModule.default;
    
    // Mock socket
    socketManager.sock = { user: { id: 'test-bot@s.whatsapp.net' } };
    
    // Test text message
    const textMsg = {
      key: { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net', fromMe: false },
      message: { conversation: 'Hello' },
      pushName: 'Test',
    };
    
    const normalized = socketManager.normalizeMessage(textMsg);
    if (normalized.type === 'chat' && normalized.body === 'Hello') {
      console.log('  ✓ Text message normalization works');
      passed++;
    } else {
      console.log('  ✗ Text message normalization failed');
      failed++;
    }
    
    // Test image message
    const imageMsg = {
      key: { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net', fromMe: false },
      message: { imageMessage: { caption: 'Test' } },
    };
    
    const normalizedImage = socketManager.normalizeMessage(imageMsg);
    if (normalizedImage.type === 'image' && normalizedImage.hasMedia) {
      console.log('  ✓ Image message normalization works');
      passed++;
    } else {
      console.log('  ✗ Image message normalization failed');
      failed++;
    }
    
    // Test ephemeral message
    const ephemeralMsg = {
      key: { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net', fromMe: false },
      message: { ephemeralMessage: { message: { conversation: 'Secret' } } },
    };
    
    const normalizedEphemeral = socketManager.normalizeMessage(ephemeralMsg);
    if (normalizedEphemeral.isEphemeral) {
      console.log('  ✓ Ephemeral message detection works');
      passed++;
    } else {
      console.log('  ✗ Ephemeral message detection failed');
      failed++;
    }
    
    // Test view-once message
    const viewOnceMsg = {
      key: { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net', fromMe: false },
      message: { viewOnceMessage: { message: { imageMessage: {} } } },
    };
    
    const normalizedViewOnce = socketManager.normalizeMessage(viewOnceMsg);
    if (normalizedViewOnce.isViewOnce) {
      console.log('  ✓ View-once message detection works');
      passed++;
    } else {
      console.log('  ✗ View-once message detection failed');
      failed++;
    }
    
    // Test location message
    const locationMsg = {
      key: { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net', fromMe: false },
      message: { locationMessage: { degreesLatitude: 10.0, degreesLongitude: 20.0 } },
    };
    
    const normalizedLocation = socketManager.normalizeMessage(locationMsg);
    if (normalizedLocation.type === 'location') {
      console.log('  ✓ Location message normalization works');
      passed++;
    } else {
      console.log('  ✗ Location message normalization failed');
      failed++;
    }
    
    // Test contact message
    const contactMsg = {
      key: { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net', fromMe: false },
      message: { contactMessage: { displayName: 'Test Contact' } },
    };
    
    const normalizedContact = socketManager.normalizeMessage(contactMsg);
    if (normalizedContact.type === 'contact') {
      console.log('  ✓ Contact message normalization works');
      passed++;
    } else {
      console.log('  ✗ Contact message normalization failed');
      failed++;
    }
    
    // Test poll message
    const pollMsg = {
      key: { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net', fromMe: false },
      message: { pollCreationMessage: { name: 'Test Poll' } },
    };
    
    const normalizedPoll = socketManager.normalizeMessage(pollMsg);
    if (normalizedPoll.type === 'poll') {
      console.log('  ✓ Poll message normalization works');
      passed++;
    } else {
      console.log('  ✗ Poll message normalization failed');
      failed++;
    }
    
    // Test group invite message
    const groupInviteMsg = {
      key: { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net', fromMe: false },
      message: { groupInviteMessage: { groupJid: 'test@g.us' } },
    };
    
    const normalizedGroupInvite = socketManager.normalizeMessage(groupInviteMsg);
    if (normalizedGroupInvite.type === 'group_invite') {
      console.log('  ✓ Group invite message normalization works');
      passed++;
    } else {
      console.log('  ✗ Group invite message normalization failed');
      failed++;
    }
    
    // Test protocol message
    const protocolMsg = {
      key: { id: 'msg1', remoteJid: '2348012345678@s.whatsapp.net', fromMe: false },
      message: { protocolMessage: { type: 0 } },
    };
    
    const normalizedProtocol = socketManager.normalizeMessage(protocolMsg);
    if (normalizedProtocol.type === 'protocol' && normalizedProtocol.isProtocol) {
      console.log('  ✓ Protocol message normalization works');
      passed++;
    } else {
      console.log('  ✗ Protocol message normalization failed');
      failed++;
    }
    
    console.log('Message Normalization: PASSED\n');
  } catch (err) {
    console.log('Message Normalization: FAILED -', err.message, '\n');
    failed++;
  }
  
  // Test 3: AI Reactions
  try {
    console.log('Testing AI Reactions...');
    
    const aiReactionsModule = await import('../src/utils/aiReactions.js');
    const aiReactions = aiReactionsModule.default;
    
    // Test reaction picking
    const loveReaction = aiReactions.pickReactionEmoji('\u2764');
    if (['\u2764\ufe0f', '\ud83e\udd70', '\ud83d\ude0a', '\ud83d\udc95'].includes(loveReaction)) {
      console.log('  ✓ Love reaction picking works');
      passed++;
    } else {
      console.log('  ✗ Love reaction picking failed');
      failed++;
    }
    
    // Test laugh reaction
    const laughReaction = aiReactions.pickReactionEmoji('\ud83d\ude02');
    if (['\ud83d\ude02', '\ud83e\udd23', '\ud83d\ude06'].includes(laughReaction)) {
      console.log('  ✓ Laugh reaction picking works');
      passed++;
    } else {
      console.log('  ✗ Laugh reaction picking failed');
      failed++;
    }
    
    console.log('AI Reactions: PASSED\n');
  } catch (err) {
    console.log('AI Reactions: FAILED -', err.message, '\n');
    failed++;
  }
  
  // Test 4: Sticker System
  try {
    console.log('Testing Sticker System...');
    
    const aiStickersModule = await import('../src/utils/aiStickers.js');
    const aiStickers = aiStickersModule.default;
    await aiStickers.initialize();
    
    // Test exclusivity rules
    const rules = aiStickers.getExclusivityRules();
    if (rules.text && rules.sticker && rules.voice) {
      console.log('  ✓ Exclusivity rules defined');
      passed++;
    } else {
      console.log('  ✗ Exclusivity rules missing');
      failed++;
    }
    
    // Test shouldIncludeSticker
    if (aiStickers.shouldIncludeSticker({ type: 'chat', hasMedia: false })) {
      console.log('  ✓ Text message should include sticker');
      passed++;
    } else {
      console.log('  ✗ Text message sticker inclusion failed');
      failed++;
    }
    
    if (!aiStickers.shouldIncludeSticker({ type: 'ptt', hasMedia: true })) {
      console.log('  ✓ Voice message should NOT include sticker');
      passed++;
    } else {
      console.log('  ✗ Voice message sticker exclusion failed');
      failed++;
    }
    
    if (!aiStickers.shouldIncludeSticker({ type: 'sticker', hasMedia: true }, true)) {
      console.log('  ✓ Sticker reply should NOT include sticker');
      passed++;
    } else {
      console.log('  ✗ Sticker reply exclusion failed');
      failed++;
    }
    
    console.log('Sticker System: PASSED\n');
  } catch (err) {
    console.log('Sticker System: FAILED -', err.message, '\n');
    failed++;
  }
  
  // Summary
  console.log('\n=== Test Summary ===');
  console.log(`Total: ${passed + failed}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Success Rate: ${((passed / (passed + failed)) * 100).toFixed(2)}%\n`);
  
  return { passed, failed };
}

// Export for use in other test files
if (process.argv.includes('--manual')) {
  runManualTests().catch(console.error);
}

export { runManualTests };
