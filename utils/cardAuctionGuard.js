module.exports = function cardAuctionGuard(schema) {
  schema.pre('save', function () {
    if (!this.isNew && this.isAuctioned && this.isModified())
      throw new Error('Card is locked in an auction.');
  });
  schema.pre(
    ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete'],
    function () {
      const allowed = this.options.auctionMutation;
      delete this.options.auctionMutation;
      if (!allowed) this.setQuery({ $and: [this.getFilter(), { isAuctioned: { $ne: true } }] });
    }
  );
};
