function localizeConfigSchema(schema, config) {
    if (!schema?.properties || !config || typeof config !== 'object')
        return schema;
    const properties = {};
    for (const [key, field] of Object.entries(schema.properties)) {
        const ov = config[key];
        properties[key] = ov
            ? { ...field, title: ov.title ?? field.title, description: ov.description ?? field.description }
            : field;
    }
    return { ...schema, properties };
}
/** Return a localized view of `plugin` for `lang`; identity when there is no matching override. */
export function localizePlugin(plugin, lang) {
    const ov = plugin.i18n && typeof plugin.i18n === 'object' ? plugin.i18n[lang] : undefined;
    if (!ov || typeof ov !== 'object')
        return plugin;
    return {
        ...plugin,
        name: ov.name ?? plugin.name,
        description: ov.description ?? plugin.description,
        configSchema: localizeConfigSchema(plugin.configSchema, ov.config),
    };
}
