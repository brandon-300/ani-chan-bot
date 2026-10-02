/**
 * Message Normalization Layer
 * Converts Baileys messages to match whatsapp-web.js format
 * This allows existing commands to work with minimal changes
 */

import { fileURLToPath } from 'url';
import path from 'path';
import socketManager from '../client/socket.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Normalize a Baileys message to match whatsapp-web.js format
 * @param {object} baileysMsg - Raw Baileys message
 * @param {object} sock - Baileys socket instance
 * @returns {object} Normalized message
 */
export function normalizeMessage(baileysMsg, sock = null) {
  const sockInstance = sock || socketManager.getSocket();
  
  if (!baileysMsg) {
    throw new Error('No message to normalize');
  }

  const { key, pushName, message, participant, timestamp, fromMe } = baileysMsg;
  
  // Determine if this is a group message
  const isGroup = key.remoteJid && key.remoteJid.endsWith('@g.us');
  
  // Determine the actual sender
  let author = null;
  let from = key.remoteJid;
  
  if (isGroup && participant) {
    author = participant;
  } else if (!fromMe) {
    author = key.remoteJid.split('@')[0];
  }

  // Extract message body
  let body = '';
  let type = 'chat';
  let hasMedia = false;
  let isMedia = false;
  let mentionedIds = [];

  if (message) {
    // Text message
    if (message.conversation) {
      body = message.conversation;
      type = 'chat';
    } else if (message.extendedTextMessage) {
      body = message.extendedTextMessage.text;
      type = 'chat';
      
      // Extract mentions
      if (message.extendedTextMessage.contextInfo && 
          message.extendedTextMessage.contextInfo.mentionedJid) {
        mentionedIds = message.extendedTextMessage.contextInfo.mentionedJid;
      }
    } else if (message.imageMessage) {
      type = 'image';
      hasMedia = true;
      isMedia = true;
      body = message.imageMessage.caption || '';
      
      // Extract mentions from caption
      if (message.imageMessage.contextInfo && 
          message.imageMessage.contextInfo.mentionedJid) {
        mentionedIds = message.imageMessage.contextInfo.mentionedJid;
      }
    } else if (message.videoMessage) {
      type = 'video';
      hasMedia = true;
      isMedia = true;
      body = message.videoMessage.caption || '';
      
      // Extract mentions
      if (message.videoMessage.contextInfo && 
          message.videoMessage.contextInfo.mentionedJid) {
        mentionedIds = message.videoMessage.contextInfo.mentionedJid;
      }
    } else if (message.stickerMessage) {
      type = 'sticker';
      hasMedia = true;
      isMedia = true;
    } else if (message.audioMessage) {
      type = 'audio';
      hasMedia = true;
      isMedia = true;
    } else if (message.pttMessage) {
      type = 'ptt';
      hasMedia = true;
      isMedia = true;
    } else if (message.reactionMessage) {
      type = 'reaction';
      body = message.reactionMessage.text || '';
    } else if (message.buttonsResponseMessage) {
      type = 'buttons_response';
      body = message.buttonsResponseMessage.selectedButtonId || '';
    } else if (message.listResponseMessage) {
      type = 'list_response';
      body = message.listResponseMessage.selectedRowId || '';
    } else if (message.templateButtonReplyMessage) {
      type = 'template_button_reply';
      body = message.templateButtonReplyMessage.selectedId || '';
    }
  }

  // Build the normalized message
  const normalizedMsg = {
    id: { _serialized: key.id },
    from: from,
    fromMe: fromMe || false,
    author: author,
    body: body,
    type: type,
    timestamp: timestamp ? new Date(timestamp * 1000) : new Date(),
    hasMedia: hasMedia,
    isMedia: isMedia,
    pushName: pushName,
    isGroup: isGroup,
    chatId: key.remoteJid,
    mentionedIds: mentionedIds,
    // Store the raw Baileys message for advanced use cases
    _baileys: baileysMsg,
    // Store the socket reference
    _sock: sockInstance,
  };

  // Add quoted message support
  if (message && (message.quotedMessage || message.extendedTextMessage?.contextInfo?.quotedMessage)) {
    const quotedMsg = message.quotedMessage || message.extendedTextMessage?.contextInfo?.quotedMessage;
    if (quotedMsg) {
      normalizedMsg.hasQuotedMsg = true;
      normalizedMsg._quoted = quotedMsg;
      
      // Add quoted message accessor
      normalizedMsg.getQuotedMessage = async () => {
        return normalizeMessage(quotedMsg, sockInstance);
      };
    }
  }

  // Add reply function
  normalizedMsg.reply = async (content, chatId, options = {}) => {
    const targetJid = chatId || from;
    return sendMessage(targetJid, content, options, sockInstance);
  };

  // Add downloadMedia function
  normalizedMsg.downloadMedia = async () => {
    return downloadMedia(baileysMsg, sockInstance);
  };

  // Add getChat function
  normalizedMsg.getChat = async () => {
    return getChat(key.remoteJid, sockInstance);
  };

  // Add getContact function
  normalizedMsg.getContact = async () => {
    return getContact(author || from, sockInstance);
  };

  // Add react function
  normalizedMsg.react = async (emoji) => {
    return react(key, emoji, sockInstance);
  };

  return normalizedMsg;
}

/**
 * Send a message
 * @param {string} jid - Target JID
 * @param {*} content - Message content
 * @param {object} options - Message options
 * @param {object} sock - Socket instance
 */
export async function sendMessage(jid, content, options = {}, sock = null) {
  const sockInstance = sock || socketManager.getSocket();
  
  if (!sockInstance) {
    throw new Error('Socket not initialized');
  }

  try {
    // Handle different content types
    if (typeof content === 'string') {
      // Text message
      await sockInstance.sendMessage(jid, { text: content }, options);
    } else if (content.mimetype || content._data || content.data) {
      // Media message (from MessageMedia-like object)
      const media = {
        ...content,
      };
      
      // Handle quoted message
      if (options.quotedMessageId) {
        media.quoted = { 
          id: options.quotedMessageId,
          remoteJid: jid,
        };
      }
      
      await sockInstance.sendMessage(jid, media, options);
    } else if (content.text && content.caption) {
      // Image with caption
      await sockInstance.sendMessage(jid, {
        image: content.data,
        caption: content.caption,
        mimetype: content.mimetype,
      }, options);
    } else {
      // Unknown content type - try to send as text
      await sockInstance.sendMessage(jid, { text: String(content) }, options);
    }
  } catch (error) {
    console.error('Failed to send message:', error);
    throw error;
  }
}

/**
 * Download media from a message
 * @param {object} baileysMsg - Baileys message
 * @param {object} sock - Socket instance
 */
export async function downloadMedia(baileysMsg, sock = null) {
  const sockInstance = sock || socketManager.getSocket();
  
  if (!sockInstance) {
    throw new Error('Socket not initialized');
  }

  const { message, key } = baileysMsg;
  
  if (!message) {
    throw new Error('No message to download media from');
  }

  // Determine media type
  let mediaMessage = null;
  let mediaType = null;

  if (message.imageMessage) {
    mediaMessage = message.imageMessage;
    mediaType = 'image';
  } else if (message.videoMessage) {
    mediaMessage = message.videoMessage;
    mediaType = 'video';
  } else if (message.stickerMessage) {
    mediaMessage = message.stickerMessage;
    mediaType = 'sticker';
  } else if (message.audioMessage) {
    mediaMessage = message.audioMessage;
    mediaType = 'audio';
  } else if (message.pttMessage) {
    mediaMessage = message.pttMessage;
    mediaType = 'ptt';
  } else if (message.documentMessage) {
    mediaMessage = message.documentMessage;
    mediaType = 'document';
  }

  if (!mediaMessage) {
    throw new Error('No media found in message');
  }

  // Download the media
  const stream = await sockInstance.downloadMediaMessage(mediaMessage);
  const chunks = [];
  
  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);

  return {
    data: buffer.toString('base64'),
    mimetype: mediaMessage.mimetype,
    filename: mediaMessage.fileName,
  };
}

/**
 * Get chat info
 * @param {string} jid - Chat JID
 * @param {object} sock - Socket instance
 */
export async function getChat(jid, sock = null) {
  const sockInstance = sock || socketManager.getSocket();
  
  if (!sockInstance) {
    throw new Error('Socket not initialized');
  }

  try {
    // For now, return basic chat info
    // Baileys doesn't have a direct getChat method
    const isGroup = jid.endsWith('@g.us');
    
    return {
      id: { _serialized: jid },
      isGroup: isGroup,
      name: jid.split('@')[0],
      // Add group metadata if available
      ...(isGroup && {
        groupMetadata: async () => {
          try {
            const metadata = await sockInstance.groupMetadata(jid);
            return {
              id: { _serialized: jid },
              name: metadata.subject,
              isGroup: true,
              participants: metadata.participants.map(p => ({
                id: { _serialized: p.id },
                isAdmin: p.isAdmin,
                isSuperAdmin: p.isSuperAdmin,
              })),
            };
          } catch (error) {
            return {
              id: { _serialized: jid },
              name: jid.split('@')[0],
              isGroup: true,
              participants: [],
            };
          }
        },
      }),
    };
  } catch (error) {
    console.error('Failed to get chat:', error);
    throw error;
  }
}

/**
 * Get contact info
 * @param {string} jid - Contact JID
 * @param {object} sock - Socket instance
 */
export async function getContact(jid, sock = null) {
  const sockInstance = sock || socketManager.getSocket();
  
  if (!sockInstance) {
    throw new Error('Socket not initialized');
  }

  try {
    // For now, return basic contact info
    return {
      id: { _serialized: jid },
      name: jid.split('@')[0],
      pushName: jid.split('@')[0],
    };
  } catch (error) {
    console.error('Failed to get contact:', error);
    throw error;
  }
}

/**
 * React to a message
 * @param {object} key - Message key
 * @param {string} emoji - Reaction emoji
 * @param {object} sock - Socket instance
 */
export async function react(key, emoji, sock = null) {
  const sockInstance = sock || socketManager.getSocket();
  
  if (!sockInstance) {
    throw new Error('Socket not initialized');
  }

  try {
    await sockInstance.sendMessage(key.remoteJid, {
      react: {
        text: emoji,
        key: key,
      },
    });
  } catch (error) {
    console.error('Failed to react:', error);
    throw error;
  }
}

/**
 * Safe get quoted message (compatibility with existing code)
 */
export async function safeGetQuotedMessage(msg, retries = 1) {
  try {
    if (msg.hasQuotedMsg && msg._quoted) {
      return normalizeMessage(msg._quoted);
    }
    return null;
  } catch (error) {
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return safeGetQuotedMessage(msg, retries - 1);
    }
    return null;
  }
}

/**
 * Safe get chat (compatibility with existing code)
 */
export async function safeGetChat(msg, retries = 1) {
  try {
    if (msg.getChat) {
      return await msg.getChat();
    }
    return await getChat(msg.from || msg.chatId);
  } catch (error) {
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return safeGetChat(msg, retries - 1);
    }
    return null;
  }
}

/**
 * Safe get contact (compatibility with existing code)
 */
export async function safeGetContact(msg, retries = 1) {
  try {
    if (msg.getContact) {
      return await msg.getContact();
    }
    return await getContact(msg.author || msg.from);
  } catch (error) {
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return safeGetContact(msg, retries - 1);
    }
    return null;
  }
}

export default {
  normalizeMessage,
  sendMessage,
  downloadMedia,
  getChat,
  getContact,
  react,
  safeGetQuotedMessage,
  safeGetChat,
  safeGetContact,
};
