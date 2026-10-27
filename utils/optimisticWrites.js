'use strict';

// Atomic updates and document saves share the same revision counter. Without
// this, a .save() can overwrite a balance changed concurrently via $inc.
module.exports = function optimisticWrites(schema) {
  schema.set('optimisticConcurrency', true);
  schema.pre('save', async function () {
    if (!this.isNew && this.__v === undefined) {
      // Old rows may lack a revision. Seed only if still missing; if an
      // atomic writer already advanced it, this document is stale.
      const seeded = await this.constructor.collection.updateOne(
        { _id: this._id, __v: { $exists: false } },
        { $set: { __v: 0 } },
        { session: this.$session() }
      );
      if (seeded.matchedCount !== 1)
        throw new (require('mongoose').Error.VersionError)(this, 0, this.modifiedPaths());
      this.__v = 0;
    }
  });
  schema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function () {
    const update = this.getUpdate();
    if (!update || Array.isArray(update)) return;
    if (update.$set) delete update.$set.__v;
    if (update.$setOnInsert) delete update.$setOnInsert.__v;
    update.$inc = { ...update.$inc, __v: 1 };
    this.setUpdate(update);
  });
};
