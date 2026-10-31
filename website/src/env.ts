// Precise runtime properties of our Pages environment.
// MONGODB_URI must be a Secret binding, never a plaintext Git variable.
export interface AniChanEnv {
  DB: unknown; // D1 is used by the existing legacy Pages handler
  MONGODB_URI?: string;
  BOT_LINK_SECRET?: string;
  WHATSAPP_LINK_ENABLED?: string;
}

export interface CatalogueCard {
  cardId: string;
  name: string;
  series: string;
  tier: string;
}

