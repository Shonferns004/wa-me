"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
const typeorm_1 = require("typeorm");
const storage_service_1 = require("../../common/storage/storage.service");
const message_entity_1 = require("../message/entities/message.entity");
const message_metadata_1 = require("../message/message-metadata");
const chat_media_archive_service_1 = require("./chat-media-archive.service");
const config = (values) => ({ get: (key, fallback) => (key in values ? values[key] : fallback) });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Retention removes an archived file. Under MESSAGE_INLINE_MEDIA=archive the row then has no copy of the media
 * left, and it must stop saying it has one. SQLite in a file, since a test closes and reopens it; on PostgreSQL
 * (DATABASE_TYPE=postgres) a schema of its own, since the marker is found with SQL that differs by dialect.
 */
describe('archive-only media after retention removes the file', () => {
    const pg = process.env.DATABASE_TYPE === 'postgres';
    const server = {
        type: 'postgres',
        host: process.env.DATABASE_HOST || 'localhost',
        port: Number(process.env.DATABASE_PORT || 5432),
        username: process.env.DATABASE_USERNAME || 'openwa',
        password: process.env.DATABASE_PASSWORD || 'openwa',
        database: process.env.DATABASE_NAME || 'openwa',
    };
    let schema = '';
    const onServer = async (sql) => {
        const admin = await new typeorm_1.DataSource(server).initialize();
        await admin.query(sql).finally(() => admin.destroy());
    };
    let dir;
    let ds;
    let repository;
    let storage;
    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-retention-marker-'));
        if (pg) {
            schema = `retention_marker_${(0, crypto_1.randomUUID)().replace(/-/g, '')}`;
            await onServer(`CREATE SCHEMA "${schema}"`);
        }
        const entities = [message_entity_1.Message];
        ds = await new typeorm_1.DataSource(pg
            ? { ...server, schema, extra: { options: `-c search_path=${schema},public` }, entities, synchronize: true }
            : { type: 'better-sqlite3', database: path.join(dir, 'data.sqlite'), entities, synchronize: true }).initialize();
        repository = ds.getRepository(message_entity_1.Message);
        storage = new storage_service_1.StorageService(config({ 'storage.type': 'local', 'storage.localPath': path.join(dir, 'media') }));
    });
    afterEach(async () => {
        jest.restoreAllMocks();
        if (ds.isInitialized)
            await ds.destroy();
        if (pg)
            await onServer(`DROP SCHEMA "${schema}" CASCADE`);
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const service = (inlineMode) => new chat_media_archive_service_1.ChatMediaArchiveService(repository, storage, config({ 'chatMedia.archiveEnabled': true, 'chatMedia.inlineMode': inlineMode, 'chatMedia.ttlDays': 1 }));
    /** An inbound image row, archived by `archive` the way the projector does after persisting it. */
    async function archivedRow(archive, extra = {}, bytes = PNG) {
        const row = await repository.save(repository.create({
            sessionId: 'sess-1',
            chatId: '628111@c.us',
            waMessageId: `WA-${(0, crypto_1.randomUUID)()}`,
            from: '628111@c.us',
            to: 'me@c.us',
            body: '',
            type: 'image',
            direction: message_entity_1.MessageDirection.INCOMING,
            status: message_entity_1.MessageStatus.SENT,
            timestamp: 1,
            metadata: { media: { mimetype: 'image/png', data: bytes.toString('base64') }, ...extra },
        }));
        expect(await archive.archive(row)).not.toBeNull();
        return repository.findOneByOrFail({ id: row.id });
    }
    const twoDaysLater = () => Date.now() + 2 * DAY_MS;
    it('no longer advertises an archived copy once the archived file is gone', async () => {
        const archive = service('archive');
        const row = await archivedRow(archive);
        expect(row.metadata.media).toMatchObject({ omitted: true, archived: true });
        await (0, message_metadata_1.updateMessageMetadata)(repository, { id: row.id }, metadata => ({ ...metadata, reactions: { a: 'like' } }));
        expect(await archive.purgeExpired(twoDaysLater())).toBe(1);
        const after = await repository.findOneByOrFail({ id: row.id });
        expect(after.mediaPath).toBeNull();
        expect(await archive.getMedia('sess-1', ['628111@c.us'], row.waMessageId)).toBeNull();
        // The list API hands this metadata to clients; `archived: true` tells them the bytes are behind the
        // media route (the dashboard fetches a preview for it), and they no longer are.
        expect(after.metadata).toEqual({
            media: { mimetype: 'image/png', omitted: true, sizeBytes: PNG.length },
            reactions: { a: 'like' },
        });
    });
    it('leaves the metadata of an inline-mode row untouched', async () => {
        const archive = service('inline');
        const row = await archivedRow(archive);
        const update = jest.spyOn(repository, 'update');
        expect(await archive.purgeExpired(twoDaysLater())).toBe(1);
        const after = await repository.findOneByOrFail({ id: row.id });
        expect(after.mediaPath).toBeNull();
        expect(after.metadata).toEqual(row.metadata);
        expect(update.mock.calls.filter(([, patch]) => 'metadata' in patch)).toEqual([]);
    });
    it('keeps the marker and the columns while the file cannot be deleted', async () => {
        const archive = service('archive');
        const row = await archivedRow(archive);
        jest.spyOn(storage, 'deleteFile').mockRejectedValue(new Error('store unreachable'));
        expect(await archive.purgeExpired(twoDaysLater())).toBe(0);
        const after = await repository.findOneByOrFail({ id: row.id });
        expect(after.mediaPath).toBe(row.mediaPath);
        expect(after.metadata.media).toMatchObject({ archived: true });
    });
    it('keeps a reaction written while the marker is dropped', async () => {
        const archive = service('archive');
        const row = await archivedRow(archive);
        const update = repository.update.bind(repository);
        let raced = false;
        jest.spyOn(repository, 'update').mockImplementation(async (where, patch) => {
            if (!raced && 'metadata' in patch) {
                raced = true;
                await (0, message_metadata_1.updateMessageMetadata)(repository, { id: row.id }, metadata => ({
                    ...metadata,
                    reactions: { b: 'love' },
                }));
            }
            return update(where, patch);
        });
        expect(await archive.purgeExpired(twoDaysLater())).toBe(1);
        const after = await repository.findOneByOrFail({ id: row.id });
        expect(after.metadata).toEqual({
            media: { mimetype: 'image/png', omitted: true, sizeBytes: PNG.length },
            reactions: { b: 'love' },
        });
    });
    it('retries a row on the next run when its marker could not be dropped', async () => {
        const archive = service('archive');
        const row = await archivedRow(archive);
        const update = repository.update.bind(repository);
        const metadataWrites = jest
            .spyOn(repository, 'update')
            .mockImplementation((where, patch) => 'metadata' in patch
            ? Promise.resolve({ affected: 0, raw: [], generatedMaps: [] })
            : update(where, patch));
        expect(await archive.purgeExpired(twoDaysLater())).toBe(0);
        expect((await repository.findOneByOrFail({ id: row.id })).mediaPath).toBe(row.mediaPath);
        metadataWrites.mockRestore();
        expect(await archive.purgeExpired(twoDaysLater())).toBe(1);
        const after = await repository.findOneByOrFail({ id: row.id });
        expect(after.mediaPath).toBeNull();
        expect(after.metadata.media).not.toHaveProperty('archived');
    });
    it.each([
        ['ASCII, 70 000 characters', 'a'.repeat(70_000)],
        // 75 000 UTF-8 bytes, inside WhatsApp's 65 536-character text limit.
        ['CJK, 25 000 characters', '中'.repeat(25_000)],
    ])('drops the marker of a media reply quoting a long text (%s)', async (_label, quotedBody) => {
        const archive = service('archive');
        const row = await archivedRow(archive, { quotedMessage: { id: 'QUOTED-1', body: quotedBody } });
        expect(row.metadata.media).toMatchObject({ omitted: true, archived: true });
        expect(await archive.purgeExpired(twoDaysLater())).toBe(1);
        const after = await repository.findOneByOrFail({ id: row.id });
        expect(after.mediaPath).toBeNull();
        expect(after.metadata).toEqual({
            media: { mimetype: 'image/png', omitted: true, sizeBytes: PNG.length },
            quotedMessage: { id: 'QUOTED-1', body: quotedBody },
        });
    });
    it('neither reads nor rewrites a large inline copy while looking for the marker', async () => {
        const archive = service('inline');
        const row = await archivedRow(archive, {}, (0, crypto_1.randomBytes)(100 * 1024));
        const read = jest.spyOn(repository, 'findOne');
        const update = jest.spyOn(repository, 'update');
        expect(await archive.purgeExpired(twoDaysLater())).toBe(1);
        const after = await repository.findOneByOrFail({ id: row.id });
        expect(after.mediaPath).toBeNull();
        expect(after.metadata).toEqual(row.metadata);
        expect(read).not.toHaveBeenCalled();
        expect(update.mock.calls.filter(([, patch]) => 'metadata' in patch)).toEqual([]);
    });
    it('keeps a large row whose marker could not be looked for until the next run', async () => {
        const archive = service('archive');
        const row = await archivedRow(archive, { quotedMessage: { id: 'QUOTED-1', body: 'a'.repeat(70_000) } });
        jest.spyOn(typeorm_1.SelectQueryBuilder.prototype, 'getExists').mockRejectedValueOnce(new Error('database busy'));
        expect(await archive.purgeExpired(twoDaysLater())).toBe(0);
        const kept = await repository.findOneByOrFail({ id: row.id });
        expect(kept.mediaPath).toBe(row.mediaPath);
        expect(kept.metadata.media).toMatchObject({ archived: true });
        expect(await archive.purgeExpired(twoDaysLater())).toBe(1);
        const after = await repository.findOneByOrFail({ id: row.id });
        expect(after.mediaPath).toBeNull();
        expect(after.metadata.media).not.toHaveProperty('archived');
    });
    it('lets the event loop run between the marker lookups of large inline copies', async () => {
        const archive = service('inline');
        for (let i = 0; i < 5; i++)
            await archivedRow(archive, {}, (0, crypto_1.randomBytes)(100 * 1024));
        // Each lookup scans a whole inline copy, and better-sqlite3 answers it without a turn of the event loop.
        let turns = 0;
        let spinning = true;
        const spin = () => {
            turns++;
            if (spinning)
                setImmediate(spin);
        };
        setImmediate(spin);
        const turnsAtLookup = [];
        // eslint-disable-next-line @typescript-eslint/unbound-method -- called through with its own receiver
        const getExists = typeorm_1.SelectQueryBuilder.prototype.getExists;
        jest.spyOn(typeorm_1.SelectQueryBuilder.prototype, 'getExists').mockImplementation(function () {
            turnsAtLookup.push(turns);
            return getExists.call(this);
        });
        const cleared = await archive.purgeExpired(twoDaysLater()).finally(() => (spinning = false));
        expect(cleared).toBe(5);
        expect(turnsAtLookup).toHaveLength(5);
        for (let i = 1; i < turnsAtLookup.length; i++) {
            expect(turnsAtLookup[i]).toBeGreaterThan(turnsAtLookup[i - 1]);
        }
    });
    // PostgreSQL computes OCTET_LENGTH and IS NOT NULL from the stored header either way; SQLite does not.
    (pg ? it.skip : it)('reads only the size of a large row in the bulk marker statement', async () => {
        const archive = service('inline');
        await archivedRow(archive);
        let issued;
        // eslint-disable-next-line @typescript-eslint/unbound-method -- called through with its own receiver
        const getRawMany = typeorm_1.SelectQueryBuilder.prototype.getRawMany;
        jest.spyOn(typeorm_1.SelectQueryBuilder.prototype, 'getRawMany').mockImplementation(function () {
            if (this.getQuery().includes('CASE WHEN'))
                issued = this.getQueryAndParameters();
            return getRawMany.call(this);
        });
        expect(await archive.purgeExpired(twoDaysLater())).toBe(1);
        const columns = await ds.query(`PRAGMA table_info("${repository.metadata.tableName}")`);
        const metadata = columns.find(column => column.name === 'metadata').cid;
        const program = await ds.query(`EXPLAIN ${issued[0]}`, issued[1]);
        // A Column read flagged for a length (p5 bit 0x40) stops at the record header; any other loads the whole value.
        const wholeLoads = program.filter(op => op.opcode === 'Column' && op.p2 === metadata && (op.p5 & 0x40) === 0);
        // The one is the LIKE branch, which runs only for a row of 64 KiB or less.
        expect(wholeLoads).toHaveLength(1);
    });
    it.each([
        ['the data source closes', () => ds.destroy()],
        ['the module is destroyed', (archive) => archive.onModuleDestroy()],
    ])('stops when %s during the marker lookups and leaves the rest for the next run', async (_label, shutDown) => {
        const archive = service('inline');
        for (let i = 0; i < 20; i++)
            await archivedRow(archive, {}, (0, crypto_1.randomBytes)(100 * 1024));
        const logger = archive
            .logger;
        const lines = ['log', 'warn', 'error'].map(level => jest.spyOn(logger, level));
        // eslint-disable-next-line @typescript-eslint/unbound-method -- called through with its own receiver
        const getExists = typeorm_1.SelectQueryBuilder.prototype.getExists;
        let lookups = 0;
        jest.spyOn(typeorm_1.SelectQueryBuilder.prototype, 'getExists').mockImplementation(async function () {
            const marked = await getExists.call(this);
            if (++lookups === 3)
                await shutDown(archive);
            return marked;
        });
        const failed = await archive.purgeExpired(twoDaysLater()).then(() => 0, () => 1);
        // A failed run is one line where it is scheduled; nothing else may be logged per remaining row.
        expect(lines.reduce((sum, spy) => sum + spy.mock.calls.length, failed)).toBeLessThanOrEqual(1);
        expect(lookups).toBe(3);
        if (!ds.isInitialized) {
            ds = await new typeorm_1.DataSource(ds.options).initialize();
            repository = ds.getRepository(message_entity_1.Message);
        }
        const left = await repository.count({ where: { mediaPath: (0, typeorm_1.Not)((0, typeorm_1.IsNull)()) } });
        expect(left).toBeGreaterThanOrEqual(17);
        expect(await service('inline').purgeExpired(twoDaysLater())).toBe(left);
        expect(await repository.count({ where: { mediaPath: (0, typeorm_1.Not)((0, typeorm_1.IsNull)()) } })).toBe(0);
    });
});
