"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaileysCatalog = exports.CATALOG_QUERY_BUDGET_MS = void 0;
const engine_transport_error_1 = require("../../common/errors/engine-transport.error");
const baileys_query_deadline_1 = require("./baileys-query-deadline");
const baileys_groups_1 = require("./baileys-groups");
/** Fetch page size for the catalog walk; larger pages mean fewer round trips to WhatsApp. */
const CATALOG_PAGE_SIZE = 50;
/**
 * Whole-request budget for a catalog read, spent across every page of the walk rather than
 * per query. Anchored to MEDIA_DOWNLOAD_TIMEOUT_MS (inbound-media-cap.ts), this repo's existing
 * number for one bounded network round trip over WhatsApp. It must stay below Baileys'
 * defaultQueryTimeoutMs (60s) to be observable at all, and below session.proxyTimeoutMs so a
 * multi-node deployment does not race two deadlines.
 */
exports.CATALOG_QUERY_BUDGET_MS = 30_000;
class BaileysCatalog {
    host;
    budgetMs;
    constructor(host, budgetMs = exports.CATALOG_QUERY_BUDGET_MS) {
        this.host = host;
        this.budgetMs = budgetMs;
    }
    /**
     * Spend part of one request-wide budget on a single query, and say so when it runs out. A WhatsApp
     * error answer (a Boom with a numeric code) becomes an HTTP refusal rather than a raw 500. A 404
     * (item-not-found) on the first query means the account has no catalog, which the routes answer as
     * an empty body, so it resolves `empty` instead. Without `empty` (a later page of the walk) the 404
     * stays a refusal, so a walk that breaks halfway fails rather than returning a short list.
     */
    async bounded(work, deadline, empty) {
        try {
            return await (0, baileys_query_deadline_1.withQueryDeadline)((0, baileys_groups_1.mapServerRefusal)('Reading the catalog', () => work().catch((error) => {
                if (empty !== undefined && (0, baileys_groups_1.refusedStatusCode)(error) === 404)
                    return empty;
                throw error;
            })), deadline - Date.now(), 'WhatsApp did not answer the catalog query in time');
        }
        catch (error) {
            if (error instanceof engine_transport_error_1.EngineTransportError) {
                // Baileys' own "timed out waiting for message" warn is silent at the default
                // BAILEYS_LOG_LEVEL, so without this line the 503 has no explanation anywhere. The message
                // tells a spent budget apart from a rate limit WhatsApp answered.
                this.host.logger.warn('Catalog query got no usable answer', { budgetMs: this.budgetMs, error: error.message });
            }
            throw error;
        }
    }
    /** Post-ensureReady socket handle. */
    sock() {
        return this.host.getSocket();
    }
    /**
     * Baileys' getCatalog returns products + cursor only; the catalog metadata our Catalog type
     * expects is synthesized from the first collection (the only named grouping the library
     * exposes). A business without collections has no catalog to describe — null.
     *
     * getCollections sends one limit (default 51) as both collection_limit and item_limit, so
     * productCount counts at most 51 products. Raising it would also raise the collection count fetched.
     */
    async getCatalog() {
        this.host.ensureReady();
        const jid = this.host.normalizedSelfJid();
        const { collections } = await this.bounded(() => this.sock().getCollections(jid), Date.now() + this.budgetMs, {
            collections: [],
        });
        const first = collections[0];
        if (!first) {
            return null;
        }
        const phone = jid.split('@')[0];
        return {
            id: first.id,
            name: first.name,
            productCount: first.products.length,
            url: `https://wa.me/c/${phone}`,
        };
    }
    async getProducts(options = {}) {
        const all = (await this.fetchAllProducts()).map(mapProduct);
        const page = options.page ?? 1;
        const limit = options.limit ?? 20;
        return {
            products: all.slice((page - 1) * limit, page * limit),
            pagination: {
                page,
                limit,
                total: all.length,
                totalPages: Math.ceil(all.length / limit),
            },
        };
    }
    async getProduct(productId) {
        const found = (await this.fetchAllProducts()).find(p => p.id === productId);
        return found ? mapProduct(found) : null;
    }
    /**
     * Walks the whole cursor chain on every call (no cursor cache), so page N costs the full
     * catalog. WhatsApp caps catalogs at ~500 products; if profiling shows the walk matters, cache
     * pages keyed by cursor and serve offsets from the cache.
     *
     * The budget is computed once and shared by every page: a per-query deadline would multiply by
     * the page count, making a ten-page walk slower than the 60s stall it replaces.
     */
    async fetchAllProducts() {
        this.host.ensureReady();
        const jid = this.host.normalizedSelfJid();
        const deadline = Date.now() + this.budgetMs;
        const products = [];
        let cursor;
        do {
            const page = await this.bounded(() => this.sock().getCatalog({ jid, limit: CATALOG_PAGE_SIZE, cursor }), deadline, cursor === undefined ? { products: [], nextPageCursor: undefined } : undefined);
            products.push(...page.products);
            // A server echoing back the cursor it was handed would otherwise spin this loop until the
            // process runs out of heap — the accumulator grows on every pass.
            if (page.nextPageCursor === cursor) {
                break;
            }
            cursor = page.nextPageCursor;
        } while (cursor);
        return products;
    }
}
exports.BaileysCatalog = BaileysCatalog;
/**
 * Map Baileys' product node onto the engine-neutral Product: priceFormatted is synthesized
 * (Baileys carries only price + currency), the imageUrls map collapses to its first URL, and
 * availability is the library's 'in stock' literal.
 */
function mapProduct(p) {
    return {
        id: p.id,
        name: p.name,
        description: p.description || undefined,
        // A catalog item without a price parses as NaN, which would reach clients as "price":null.
        ...(Number.isFinite(p.price) && { price: p.price, priceFormatted: formatPrice(p.price, p.currency) }),
        // Read from the <currency> child the same way, so an item without one has none to report.
        ...(p.currency && { currency: p.currency }),
        imageUrl: Object.values(p.imageUrls ?? {})[0],
        url: p.url ?? '',
        isAvailable: p.availability === 'in stock',
        retailerId: p.retailerId,
    };
}
function formatPrice(price, currency) {
    if (!currency)
        return new Intl.NumberFormat('en').format(price);
    try {
        return new Intl.NumberFormat('en', { style: 'currency', currency }).format(price);
    }
    catch {
        // Unknown/invalid ISO currency code — Intl throws RangeError; fall back to a plain pair.
        return `${currency} ${price}`;
    }
}
