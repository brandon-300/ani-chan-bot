/**
 * Expose a function to the page if it does not exist
 *
 * NOTE:
 * Rewrite it to 'upsertFunction' after updating Puppeteer to 20.6 or higher
 * using page.removeExposedFunction
 * https://pptr.dev/api/puppeteer.page.removeexposedfunction
 *
 * @param {object} page - Puppeteer Page instance
 * @param {string} name
 * @param {Function} fn
 */
async function exposeFunctionIfAbsent(page, name, fn) {
    const exist = await page.evaluate((name) => {
        return !!window[name];
    }, name);
    if (exist) {
        return;
    }
    try {
        await page.exposeFunction(name, fn);
    } catch (err) {
        // The existence check above isn't atomic with exposeFunction: two
        // concurrent injections (e.g. during the post-auth page reload) can
        // both pass the check, and the loser lands here. The binding exists
        // either way, so this specific race is safe to swallow.
        if (!/already exists/.test(err.message)) {
            throw err;
        }
    }
}

module.exports = { exposeFunctionIfAbsent };
