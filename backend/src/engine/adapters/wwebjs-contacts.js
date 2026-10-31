"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WwebjsContacts = void 0;
exports.readLeanContacts = readLeanContacts;
exports.readCurrentLid = readCurrentLid;
const common_1 = require("@nestjs/common");
const engine_not_ready_error_1 = require("../../common/errors/engine-not-ready.error");
const engine_transport_error_1 = require("../../common/errors/engine-transport.error");
const wa_id_1 = require("../identity/wa-id");
const whatsapp_web_js_types_1 = require("../types/whatsapp-web-js.types");
const wwebjs_host_1 = require("./wwebjs-host");
const wwebjs_lifecycle_1 = require("./wwebjs-lifecycle");
/**
 * Read the contact list IN-PAGE, projected to only the fields {@link WwebjsContacts.toContact} keeps,
 * yielding to the page event loop every 256 contacts so the liveness probe's queued `getState()`
 * evaluate can interleave (#1501). whatsapp-web.js's own `client.getContacts()` maps the same
 * `window.WWebJS.getContactModel`, but over a `Promise.all` with no await for personal contacts, so it
 * runs as one uninterrupted synchronous stretch that starves the probe on a large address book and
 * makes the watchdog tear a healthy session down mid-read. The per-contact `serialize()` cost is
 * unchanged; the yield is what makes the read probe-safe regardless of size.
 *
 * Reusing `getContactModel` keeps `id`/`number`/`name`/`pushname`/`isMyContact`/`isBlocked` byte
 * identical to `getContacts()` (`Contact.number` is `data.userid`), and the raw `id` stays readable by
 * {@link readWid} (`_serialized`, the post-rename `$1`, or a lid `phoneNumber` string all resolve).
 * `BusinessProfile.find` is skipped: its only output, `res.businessProfile`, is not one of the six
 * fields, so dropping it costs nothing and saves a network fetch per business contact.
 */
async function readLeanContacts() {
    const w = window;
    // A copy: getModelsArray() is the collection's live array, which grows when a new contact writes,
    // so indexing it across the yields below would read one contact twice and skip another.
    const models = w.require('WAWebCollections').Contact.getModelsArray().slice();
    const rows = [];
    let failed = 0;
    let firstError;
    for (let i = 0; i < models.length; i++) {
        // One model WhatsApp Web cannot read (getContactModel's getAlternateUserWid throws "Invalid get
        // call using deviceWid" for a device-scoped wid, #1720) must not reject the whole walk. It is
        // counted and skipped; whatsapp-web.js's own getContacts() never returned such an entry either,
        // because its Promise.all rejected on it.
        try {
            const m = w.WWebJS.getContactModel(models[i]);
            rows.push({
                id: m.id,
                name: m.name,
                pushname: m.pushname,
                number: m.userid,
                isMyContact: m.isMyContact,
                isBlocked: m.isBlocked,
            });
        }
        catch (error) {
            failed++;
            if (firstError === undefined)
                firstError = error instanceof Error ? error.message : String(error);
        }
        // Yield every 256 contacts so the getState() liveness probe can interleave (#1501);
        // raise the stride if the read ever gets too chatty on a very large address book.
        if ((i & 0xff) === 0xff)
            await new Promise(resolve => setTimeout(resolve));
    }
    return { rows, failed, firstError };
}
/**
 * Read IN-PAGE the LID WhatsApp Web already holds for a phone id, or null when it holds none. Local only:
 * unlike `client.getContactLidAndPhone`, which runs an existence query for a phone whose LID the page does
 * not know, this sends nothing to WhatsApp. Self-contained, since Puppeteer ships it to the page as source.
 */
function readCurrentLid(phoneId) {
    const w = window;
    const lid = w.require('WAWebApiContact').getCurrentLid(w.require('WAWebWidFactory').createWid(phoneId));
    return lid?._serialized || lid?.$1 || null;
}
/**
 * Contact operations extracted from WhatsAppWebJsAdapter. The adapter keeps the public methods as
 * thin forwarders and injects the shared host surface (./wwebjs-host) via closures, so the delegate
 * never touches lifecycle state directly.
 */
class WwebjsContacts {
    host;
    constructor(host) {
        this.host = host;
    }
    /** Post-ensureReady client handle. */
    client() {
        return this.host.getClient();
    }
    /**
     * Map a raw whatsapp-web.js contact to the library-agnostic {@link Contact}. The id is read
     * through {@link readWid} so both the `_serialized` and post-rename `$1` shapes resolve; a
     * contact with no readable id returns null so callers can skip it instead of dereferencing
     * unguarded (the shape that lets a single bad entry reject the whole request).
     */
    toContact(c) {
        const id = (0, whatsapp_web_js_types_1.readWid)(c.id);
        if (!id)
            return null;
        return {
            id,
            name: c.name || undefined,
            pushName: c.pushname || undefined,
            // whatsapp-web.js answers a contact migrated to privacy-id addressing under its phone id (the
            // model's `phoneNumber`) but leaves `number` at the LID's digits, so a user id's number is read
            // from the id. A LID with no known phone keeps the engine's number.
            number: (0, wa_id_1.parseWaId)(id).kind === 'user' ? (0, wa_id_1.userPart)(id) : c.number,
            isMyContact: c.isMyContact,
            isBlocked: c.isBlocked,
        };
    }
    /**
     * WhatsApp Web holds a contact migrated to privacy-id addressing twice, as its LID record and its
     * phone record, and {@link toContact} reads the first under the phone id, so one id comes back twice.
     * The copies are folded into the first one's place, which keeps the paging order stable, and a name or
     * a flag only the other copy holds survives (a block is never dropped).
     */
    static mergeById(contacts) {
        const byId = new Map();
        for (const c of contacts) {
            const first = byId.get(c.id);
            byId.set(c.id, first
                ? {
                    ...first,
                    name: first.name ?? c.name,
                    pushName: first.pushName ?? c.pushName,
                    isMyContact: first.isMyContact || c.isMyContact,
                    isBlocked: first.isBlocked || c.isBlocked,
                }
                : c);
        }
        return [...byId.values()];
    }
    async getContacts() {
        this.host.ensureReady();
        let raw;
        let unreadable;
        let firstError;
        try {
            // A direct in-page walk that yields so the liveness probe is not starved (see readLeanContacts,
            // #1501), instead of whatsapp-web.js's atomic client.getContacts(). The projected rows are a
            // strict subset of a Contact; the mapping below reads only those six fields.
            const page = this.client()
                .pupPage;
            const read = await page?.evaluate(readLeanContacts);
            raw = (read?.rows ?? []);
            unreadable = read?.failed ?? 0;
            firstError = read?.firstError;
        }
        catch (error) {
            (0, wwebjs_host_1.rethrowIfNavigation)(this.host, error);
            // A dead page surfaces here as a raw Puppeteer error; convert it to the documented transport
            // failure the way wwebjs-chats.ts does, so a transport death answers 503 instead of a bare 500.
            if (this.host.isPageTransportError(error)) {
                this.host.reportIfPageTransportError(error, 'getContacts');
                throw new engine_transport_error_1.EngineTransportError('Transport died while reading contacts');
            }
            // A walk that outran the protocol budget got no answer: a 503, but no death.
            if ((0, wwebjs_lifecycle_1.isProtocolTimeout)(error)) {
                throw new engine_transport_error_1.EngineTransportError('WhatsApp Web did not answer the contact list read in time');
            }
            throw error;
        }
        // Read every id through readWid (so the `_serialized`->`$1` rename lands here too) and skip
        // entries with no readable id, counted and logged like the chats path, rather than dropping
        // the whole address book silently.
        const contacts = [];
        let skipped = 0;
        for (const c of raw) {
            const mapped = this.toContact(c);
            if (!mapped) {
                skipped++;
                continue;
            }
            contacts.push(mapped);
        }
        // A systemic page failure (a renamed WA Web module, WWebJS not injected), not one unreadable
        // entry: answer an error rather than a list a syncing consumer would read as every contact
        // deleted. That covers models that exist but none mapped, and a failure that left only blocked
        // contacts: getContactModel skips getAlternateUserWid for a blocked contact, so a blocked row
        // still reads when that call is broken for everyone else.
        if ((unreadable > 0 && !contacts.some(c => !c.isBlocked)) || (contacts.length === 0 && skipped > 0)) {
            const reason = `WhatsApp Web could not read any unblocked contact (${unreadable} failed, ${skipped} without an id, ` +
                `${contacts.length} blocked read)${firstError ? `: ${firstError}` : ''}`;
            // Nest does not log an HttpException and the contact service logs nothing, so this line is the
            // only server-side trace of a page-wide failure.
            this.host.logger.error(reason);
            throw new common_1.InternalServerErrorException(reason);
        }
        if (skipped > 0) {
            this.host.logger.warn(`Skipped ${skipped} contact(s) without a serialized id`);
        }
        if (unreadable > 0) {
            this.host.logger.warn(`Skipped ${unreadable} contact(s) WhatsApp Web could not read`, { error: firstError });
        }
        return WwebjsContacts.mergeById(contacts);
    }
    async getContactById(contactId) {
        this.host.ensureReady();
        try {
            const contact = await this.client().getContactById(contactId);
            return this.toContact(contact);
        }
        catch (error) {
            (0, wwebjs_host_1.rethrowIfNavigation)(this.host, error);
            // Unlike the avatar lookup, a throw here can legitimately mean the contact is absent:
            // `window.WWebJS.getContact` has no try/catch and reads `contact.isBusiness` straight off
            // `Contact.find`, so an unknown id throws a TypeError on null. Null (→ 404) stays the answer
            // for that. A dead page is not a missing contact, though, and this was the one lookup that
            // never separated the two.
            if (this.host.isPageTransportError(error)) {
                this.host.reportIfPageTransportError(error, 'getContactById');
                throw new engine_transport_error_1.EngineTransportError(`Transport died while reading contact ${contactId}`);
            }
            // A command that outran the protocol budget got no answer either way: a 503, but no death.
            if ((0, wwebjs_lifecycle_1.isProtocolTimeout)(error)) {
                throw new engine_transport_error_1.EngineTransportError(`WhatsApp Web did not answer the read of contact ${contactId} in time`);
            }
            this.host.logger.warn(`Failed to get contact: ${contactId}`, { error: String(error) });
            return null;
        }
    }
    /**
     * The lookup as WhatsApp Web answers it: `<lid>@lid` for a contact migrated to privacy-id addressing,
     * else `<phone>@c.us`, or null when the number is not registered. The send path needs the `@lid`
     * (see WwebjsMessaging.resolveSendId); {@link getNumberId} is the answer that crosses the engine boundary.
     */
    async lookupNumberId(number) {
        this.host.ensureReady();
        const numberId = await (0, wwebjs_host_1.withPage)(this.host, 'getNumberId', () => this.client().getNumberId(number));
        // Read both property names: a WA Web build that renamed `_serialized` would otherwise make
        // every number look unregistered — and checkNumberExists below reports exactly that.
        return (0, whatsapp_web_js_types_1.readWid)(numberId) ?? null;
    }
    async getNumberId(number) {
        const wid = await this.lookupNumberId(number);
        if (!wid?.endsWith('@lid'))
            return wid;
        // The contract is the neutral `<phone>@c.us` WhatsApp holds for the account, which is what the Baileys
        // engine answers. It can differ from the digits typed (a Brazilian, Mexican or Argentine number with or
        // without its extra digit). A migrated contact's lookup names its `@lid`, the engine's own scheme, so the
        // phone is read back through it. When WhatsApp Web knows none, the typed number stands in, and a send to
        // it re-resolves to the lid. That read runs a second existence query when the page holds no phone for the
        // lid, so its failure answers the typed number too: the lookup above already settled that the number
        // exists. A session or page that died meanwhile still answers 409 or 503, as every read does.
        const typed = `${(0, wa_id_1.userPart)(number).replace(/\D/g, '')}@c.us`;
        try {
            const phone = await (0, wwebjs_host_1.withPage)(this.host, 'getNumberId', () => this.resolveContactPhone(wid));
            return phone ? `${phone}@c.us` : typed;
        }
        catch (error) {
            if (error instanceof engine_not_ready_error_1.EngineNotReadyError || error instanceof engine_transport_error_1.EngineTransportError)
                throw error;
            this.host.logger.debug('Could not read the phone of a migrated number, answering the typed number', {
                error: String(error),
            });
            return typed;
        }
    }
    async checkNumberExists(number) {
        return (await this.lookupNumberId(number)) !== null;
    }
    async resolveContactPhone(contactId) {
        this.host.ensureReady();
        // Queried one id at a time: the batch form is prone to "Evaluation failed" and rate-limiting
        // (whatsapp-web.js #3857/#3969). `pn` is the phone JID (`<digits>@c.us`) when the account knows
        // the mapping. An empty/absent pn RESOLVES to null (a definitive "no mapping" answer); a thrown
        // error PROPAGATES - the lid resolver must not mistake a transient failure (dead page,
        // evaluation error, rate limit) for "this contact has no phone" and clobber a valid stored
        // mapping with it. The HTTP route that promises null-on-failure swallows at its boundary
        // (contact.service.resolveContactPhone).
        const [result] = await this.client().getContactLidAndPhone([contactId]);
        const pn = result?.pn;
        return pn ? pn.replace(/@c\.us$/i, '').replace(/\D/g, '') || null : null;
    }
    async upsertContact(contactId, firstName, lastName = '') {
        this.host.ensureReady();
        // wwjs addresses the addressbook entry by PHONE NUMBER, not JID (Client.js:3266). lastName is
        // positional and required there, so an absent one is passed as an empty string rather than
        // undefined, which would land in the page-side payload as the literal string "undefined".
        // syncToAddressbook is left at its default (false): writing to the device addressbook is a
        // heavier, separately-consented action than saving the WhatsApp contact.
        await (0, wwebjs_host_1.withPage)(this.host, 'upsertContact', () => this.client().saveOrEditAddressbookContact((0, wa_id_1.userPart)(contactId), firstName, lastName));
        this.host.logger.debug('Saved addressbook contact', { contactId });
    }
    async deleteContact(contactId) {
        this.host.ensureReady();
        await (0, wwebjs_host_1.withPage)(this.host, 'deleteContact', () => this.client().deleteAddressbookContact((0, wa_id_1.userPart)(contactId)));
        this.host.logger.debug('Deleted addressbook contact', { contactId });
    }
    async blockContact(contactId) {
        this.host.ensureReady();
        await (0, wwebjs_host_1.withPage)(this.host, 'blockContact', async () => {
            const contact = await this.client().getContactById(contactId);
            // The contact acts through its own client, which getClient's readiness check never sees again.
            this.host.ensureReady();
            await contact.block();
        });
        this.host.logger.debug('Blocked contact', { contactId });
    }
    /**
     * The read half of block/unblockContact. Ids only — the neutral common subset with Baileys,
     * whose blocklist query answers bare jids. An entry whose wid is unreadable (#747 rename
     * hazard) is dropped rather than reported as the literal "undefined". A contact blocked under both
     * its LID and its phone is two entries that read as one id, which is listed once.
     */
    async getBlockedContacts() {
        this.host.ensureReady();
        const contacts = await (0, wwebjs_host_1.withPage)(this.host, 'getBlockedContacts', () => this.client().getBlockedContacts());
        const ids = contacts.map(c => (0, whatsapp_web_js_types_1.readWid)(c.id)).filter((id) => Boolean(id));
        return [...new Set(ids)];
    }
    async unblockContact(contactId) {
        this.host.ensureReady();
        await (0, wwebjs_host_1.withPage)(this.host, 'unblockContact', async () => {
            const contact = await this.client().getContactById(contactId);
            this.host.ensureReady();
            await contact.unblock();
        });
        this.host.logger.debug('Unblocked contact', { contactId });
    }
    async getProfilePicture(contactId) {
        this.host.ensureReady();
        // WhatsApp Web keys a migrated contact's chat by its LID, so the lookup by a phone id can come back empty
        // or fail where the LID answers (the Number Checker asks by the phone id its check returned). It is
        // retried once by the LID the page holds; a dead or unanswering page is not retried, and a retry that
        // gets nothing leaves the first outcome standing.
        const byLid = (0, wa_id_1.parseWaId)(contactId).kind === 'user';
        let url;
        try {
            url = await this.client().getProfilePicUrl(contactId);
        }
        catch (error) {
            (0, wwebjs_host_1.rethrowIfNavigation)(this.host, error);
            const pageDown = this.host.isPageTransportError(error) || (0, wwebjs_lifecycle_1.isProtocolTimeout)(error);
            const viaLid = byLid && !pageDown ? await this.profilePictureByLid(contactId) : undefined;
            if (viaLid)
                return viaLid;
            // Nothing reaching here is a statement about the avatar, so nothing reaching here may become
            // null. Returning null would answer 200 with {"url": null} — byte-identical to the verdict
            // above — and a caller that caches "no avatar" would record absence for a lookup that never
            // produced one. The page throws for two distinct reasons and we cannot tell them apart from
            // the message: `getChat` failing to resolve the contact at all, or the profile-pic bridge
            // failing. 404 would assert the first; 503 says only that we could not reach an answer, which
            // is all we know.
            //
            // NOTE the Baileys adapter does the OPPOSITE on this same interface method, and correctly:
            // there a no-picture verdict *is* delivered as a throw, so it swallows to null and uses its
            // own deadline to separate a verdict from a non-answer. Do not harmonise the two into a shared
            // helper — the engines disagree about what a throw means.
            this.host.reportIfPageTransportError(error, 'getProfilePicture');
            this.host.logger.warn(`Failed to get profile picture for ${contactId}: ${String(error)}`);
            throw new engine_transport_error_1.EngineTransportError(`Could not read the profile picture for ${contactId}: ${String(error)}`);
        }
        return url || (byLid ? await this.profilePictureByLid(contactId) : undefined) || null;
    }
    /**
     * The picture of a phone id looked up by the LID WhatsApp Web holds for it (no query is sent to find one),
     * or undefined when there is no LID or that lookup also gets nothing. A session torn down meanwhile still
     * answers 409: the client is taken through the readiness check before each page call.
     */
    async profilePictureByLid(phoneId) {
        try {
            const page = this.client().pupPage;
            const lid = await page?.evaluate(readCurrentLid, phoneId);
            if (!lid)
                return undefined;
            return (await this.client().getProfilePicUrl(lid)) || undefined;
        }
        catch (error) {
            if (error instanceof engine_not_ready_error_1.EngineNotReadyError)
                throw error;
            this.host.reportIfPageTransportError(error, 'getProfilePicture');
            this.host.logger.debug('Could not read a profile picture by its LID', { error: String(error) });
            return undefined;
        }
    }
}
exports.WwebjsContacts = WwebjsContacts;
