import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { infraApi } from '../services/api';
import { useToast } from './useToast';
/**
 * Owns the save-configuration request: the in-flight `saving` flag and the two failure toasts. Hands
 * the new profile list to `onSaved` instead of driving the restart modal directly, so the edge to the
 * restart flow stays one-way.
 */
export function useConfigSave({ buildPayload, onSaved }) {
    const { t } = useTranslation();
    const toast = useToast();
    const [saving, setSaving] = useState(false);
    const saveConfig = async () => {
        setSaving(true);
        try {
            const payload = buildPayload();
            const result = await infraApi.saveConfig(payload);
            if (result.saved) {
                await onSaved(result.profiles || [], payload);
            }
            else {
                toast.error(t('infrastructure.toasts.saveFailed'), result.message);
            }
        }
        catch (err) {
            toast.error(t('infrastructure.toasts.saveFailed'), err instanceof Error ? err.message : t('common.unknownError'));
        }
        finally {
            setSaving(false);
        }
    };
    return { saving, saveConfig };
}
