"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const common_1 = require("@nestjs/common");
const template_service_1 = require("./template.service");
const template_entity_1 = require("./entities/template.entity");
const session_entity_1 = require("../session/entities/session.entity");
const template_render_1 = require("../../common/utils/template-render");
function createMockTemplate(overrides = {}) {
    return {
        id: 'tpl-uuid-1',
        sessionId: 'sess-1',
        name: 'order-confirmation',
        body: 'Hi {{customer}}, order {{orderId}} shipped.',
        header: null,
        footer: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        session: undefined,
        ...overrides,
    };
}
describe('TemplateService', () => {
    let service;
    let repository;
    let sessionRepository;
    beforeEach(async () => {
        repository = {
            find: jest.fn(),
            findOne: jest.fn(),
            create: jest.fn().mockImplementation((data) => ({ id: 'tpl-uuid-1', ...data })),
            save: jest.fn().mockImplementation((tpl) => Promise.resolve(tpl)),
            remove: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue({ affected: 1 }),
        };
        sessionRepository = { exists: jest.fn().mockResolvedValue(true) };
        const module = await testing_1.Test.createTestingModule({
            providers: [
                template_service_1.TemplateService,
                { provide: (0, typeorm_1.getRepositoryToken)(template_entity_1.Template, 'data'), useValue: repository },
                { provide: (0, typeorm_1.getRepositoryToken)(session_entity_1.Session, 'data'), useValue: sessionRepository },
            ],
        }).compile();
        service = module.get(template_service_1.TemplateService);
    });
    // ── create ────────────────────────────────────────────────────────
    describe('create', () => {
        it('rejects a session that does not exist with 404 before touching the templates table', async () => {
            sessionRepository.exists.mockResolvedValue(false);
            await expect(service.create('ghost', { name: 'n', body: 'b' })).rejects.toThrow(new common_1.NotFoundException("Session with id 'ghost' not found"));
            expect(sessionRepository.exists).toHaveBeenCalledWith({ where: { id: 'ghost' } });
            expect(repository.save).not.toHaveBeenCalled();
        });
        it('should create a template with normalized null header/footer', async () => {
            await service.create('sess-1', { name: 'welcome', body: 'Hi {{name}}' });
            expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({
                sessionId: 'sess-1',
                name: 'welcome',
                body: 'Hi {{name}}',
                header: null,
                footer: null,
            }));
            expect(repository.save).toHaveBeenCalled();
        });
        it('should persist optional header and footer when provided', async () => {
            await service.create('sess-1', {
                name: 'promo',
                body: 'Buy now',
                header: 'OpenWA Store',
                footer: 'Reply STOP to opt out',
            });
            expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ header: 'OpenWA Store', footer: 'Reply STOP to opt out' }));
        });
    });
    // ── findBySession ─────────────────────────────────────────────────
    describe('findBySession', () => {
        it('should list templates for a session ordered by createdAt DESC', async () => {
            repository.find.mockResolvedValue([createMockTemplate()]);
            const result = await service.findBySession('sess-1');
            expect(repository.find).toHaveBeenCalledWith({ where: { sessionId: 'sess-1' }, order: { createdAt: 'DESC' } });
            expect(result).toHaveLength(1);
        });
    });
    // ── findOne ───────────────────────────────────────────────────────
    describe('findOne', () => {
        it('should return a template scoped to the session', async () => {
            const template = createMockTemplate();
            repository.findOne.mockResolvedValue(template);
            const result = await service.findOne('sess-1', 'tpl-uuid-1');
            expect(repository.findOne).toHaveBeenCalledWith({ where: { id: 'tpl-uuid-1', sessionId: 'sess-1' } });
            expect(result).toBe(template);
        });
        it('should throw NotFoundException when the template does not exist', async () => {
            repository.findOne.mockResolvedValue(null);
            await expect(service.findOne('sess-1', 'missing')).rejects.toThrow(common_1.NotFoundException);
        });
    });
    // ── resolve ───────────────────────────────────────────────────────
    describe('resolve', () => {
        it('should resolve by templateId', async () => {
            const template = createMockTemplate();
            repository.findOne.mockResolvedValue(template);
            const result = await service.resolve('sess-1', { templateId: 'tpl-uuid-1' });
            expect(repository.findOne).toHaveBeenCalledWith({ where: { id: 'tpl-uuid-1', sessionId: 'sess-1' } });
            expect(result).toBe(template);
        });
        it('should resolve by templateName deterministically (earliest first)', async () => {
            const template = createMockTemplate();
            repository.findOne.mockResolvedValue(template);
            const result = await service.resolve('sess-1', { templateName: 'order-confirmation' });
            // Order by createdAt ASC so resolve-by-name is deterministic even before the unique index is
            // enforced (and after, there is only one row anyway).
            expect(repository.findOne).toHaveBeenCalledWith({
                where: { name: 'order-confirmation', sessionId: 'sess-1' },
                order: { createdAt: 'ASC' },
            });
            expect(result).toBe(template);
        });
        it('should throw NotFoundException when name does not resolve', async () => {
            repository.findOne.mockResolvedValue(null);
            await expect(service.resolve('sess-1', { templateName: 'nope' })).rejects.toThrow(common_1.NotFoundException);
        });
        // PostgreSQL refuses a NUL in a bound text parameter, so the query would fail as a 500. No stored
        // name can hold one (the write DTOs refuse it), so the lookup answers 404 without querying.
        it('should throw NotFoundException for a name containing NUL without querying', async () => {
            await expect(service.resolve('sess-1', { templateName: 'promo\u0000' })).rejects.toThrow(common_1.NotFoundException);
            expect(repository.findOne).not.toHaveBeenCalled();
        });
        // Ids are server-generated uuids, so none holds a NUL; the id lookup answers 404 the same way.
        it('should throw NotFoundException for an id containing NUL without querying', async () => {
            await expect(service.resolve('sess-1', { templateId: 'abc\u0000' })).rejects.toThrow(common_1.NotFoundException);
            await expect(service.findOne('sess-1', 'abc\u0000')).rejects.toThrow(common_1.NotFoundException);
            expect(repository.findOne).not.toHaveBeenCalled();
        });
        // A malformed request, not a missing resource: a client reading 404 as "template deleted" would
        // take the wrong branch.
        it('should throw BadRequestException when neither id nor name is provided', async () => {
            await expect(service.resolve('sess-1', {})).rejects.toThrow(common_1.BadRequestException);
        });
    });
    // ── update ────────────────────────────────────────────────────────
    describe('update', () => {
        it('should update only the provided fields', async () => {
            const template = createMockTemplate();
            repository.findOne.mockResolvedValue(template);
            await service.update('sess-1', 'tpl-uuid-1', { body: 'Updated body' });
            expect(repository.update).toHaveBeenCalledWith({ id: 'tpl-uuid-1', sessionId: 'sess-1' }, { body: 'Updated body' });
            expect(repository.save).not.toHaveBeenCalled();
        });
        it('should throw NotFoundException for an unknown template', async () => {
            repository.findOne.mockResolvedValue(null);
            await expect(service.update('sess-1', 'missing', { body: 'x' })).rejects.toThrow(common_1.NotFoundException);
        });
    });
    // ── delete ────────────────────────────────────────────────────────
    describe('delete', () => {
        it('should remove an existing template', async () => {
            const template = createMockTemplate();
            repository.findOne.mockResolvedValue(template);
            await service.delete('sess-1', 'tpl-uuid-1');
            expect(repository.remove).toHaveBeenCalledWith(template);
        });
        it('should throw NotFoundException when deleting a missing template', async () => {
            repository.findOne.mockResolvedValue(null);
            await expect(service.delete('sess-1', 'missing')).rejects.toThrow(common_1.NotFoundException);
        });
    });
    // ── name uniqueness (one name per session) ────────────────────────
    describe('name uniqueness', () => {
        const uniqueViolation = () => Object.assign(new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: templates.sessionId, templates.name'), {
            code: 'SQLITE_CONSTRAINT',
        });
        it('translates a duplicate-name violation on create into 409 Conflict', async () => {
            repository.save.mockRejectedValueOnce(uniqueViolation());
            await expect(service.create('sess-1', { name: 'dup', body: 'x' })).rejects.toThrow(common_1.ConflictException);
        });
        it('translates a duplicate-name violation on update into 409 Conflict', async () => {
            repository.findOne.mockResolvedValue(createMockTemplate());
            repository.update.mockRejectedValueOnce(uniqueViolation());
            await expect(service.update('sess-1', 'tpl-uuid-1', { name: 'dup' })).rejects.toThrow(common_1.ConflictException);
        });
        it('rethrows a non-uniqueness DB error unchanged', async () => {
            repository.save.mockRejectedValueOnce(new Error('disk I/O error'));
            await expect(service.create('sess-1', { name: 'x', body: 'y' })).rejects.toThrow('disk I/O error');
        });
    });
});
// ── renderTemplate (shared utility) ───────────────────────────────────
describe('renderTemplate', () => {
    it('should substitute known {{key}} placeholders', () => {
        const result = (0, template_render_1.renderTemplate)('Hi {{name}}, your code is {{code}}.', { name: 'Alice', code: '1234' });
        expect(result).toBe('Hi Alice, your code is 1234.');
    });
    it('should leave unmatched placeholders literal', () => {
        const result = (0, template_render_1.renderTemplate)('Hi {{name}}, ref {{missing}}.', { name: 'Bob' });
        expect(result).toBe('Hi Bob, ref {{missing}}.');
    });
    it('should tolerate surrounding whitespace inside the braces', () => {
        const result = (0, template_render_1.renderTemplate)('Hello {{ name }}', { name: 'Carol' });
        expect(result).toBe('Hello Carol');
    });
    it('should default to an empty vars map and leave all placeholders literal', () => {
        expect((0, template_render_1.renderTemplate)('Order {{id}}')).toBe('Order {{id}}');
    });
    it('should treat a null variable value as missing (left literal)', () => {
        const result = (0, template_render_1.renderTemplate)('Hi {{name}}', { name: null });
        expect(result).toBe('Hi {{name}}');
    });
    it('should coerce non-string values to string', () => {
        const result = (0, template_render_1.renderTemplate)('Count: {{n}}', { n: 7 });
        expect(result).toBe('Count: 7');
    });
    it('should render a body at the maximum supported length without truncation', () => {
        // The DTO caps body length at 4096; the renderer itself imposes no cap and
        // must return content of the same magnitude when no placeholders are present.
        const body = 'x'.repeat(4096);
        expect((0, template_render_1.renderTemplate)(body, {})).toHaveLength(4096);
    });
});
