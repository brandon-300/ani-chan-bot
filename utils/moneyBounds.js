const { BusinessError } = require('./transaction');
module.exports = function moneyBounds(schema, fields) {
  for (const field of fields)
    schema
      .path(field)
      .validate(
        (value) => Number.isSafeInteger(value) && value >= 0,
        'Balance must be a non-negative safe integer'
      );
  schema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function () {
    const update = this.getUpdate();
    if (!update || Array.isArray(update)) return;
    const clauses = [];
    for (const field of fields) {
      for (const value of [update.$set?.[field], update[field]]) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
          throw new BusinessError('Balance limit exceeded.');
      }
      const delta = update.$inc?.[field];
      if (delta === undefined) continue;
      if (!Number.isSafeInteger(delta)) throw new BusinessError('Invalid balance change.');
      clauses.push({
        [field]: { $gte: Math.max(0, -delta), $lte: Number.MAX_SAFE_INTEGER - Math.max(0, delta) },
      });
    }
    if (clauses.length) this.setQuery({ $and: [this.getFilter(), ...clauses] });
  });
};
