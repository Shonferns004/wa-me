import { Archive, ArchiveRestore, Ban, Bell, BellOff, Eraser, Info, LogOut, Mail, Pin, PinOff, ShieldCheck, Trash2, User, UserPen, } from 'lucide-react';
/**
 * The actions a chat offers, in WhatsApp's order: what it is, how it sits in the list, then what cannot
 * be taken back. Group chats get their group actions, 1:1 chats their contact ones; an action whose
 * handler is absent (a read-only key) is left out.
 */
export function chatActionItems(chat, actions, t) {
    const group = chat.kind === 'group';
    const direct = chat.kind === 'individual';
    const items = [];
    const add = (handler, item) => {
        if (handler)
            items.push({ ...item, run: handler });
    };
    if (group)
        add(actions.onGroupInfo, { key: 'info', icon: <Info size={18}/>, label: t('chats.group.info') });
    if (direct) {
        add(actions.onContactInfo, { key: 'contact', icon: <User size={18}/>, label: t('chats.contactInfo') });
        const addressable = actions.canSaveContact?.(chat) ?? true;
        add(actions.onSaveContact, {
            key: 'save',
            icon: <UserPen size={18}/>,
            label: actions.isSavedContact?.(chat) ? t('chats.rowActions.renameContact') : t('chats.rowActions.saveContact'),
            ...(addressable ? {} : { disabled: true, hint: t('chats.rowActions.saveContactUnavailable') }),
        });
    }
    add(actions.onTogglePin, {
        key: 'pin',
        icon: chat.pinned ? <PinOff size={18}/> : <Pin size={18}/>,
        label: chat.pinned ? t('chats.rowActions.unpin') : t('chats.rowActions.pin'),
    });
    add(actions.onMute, {
        key: 'mute',
        icon: chat.muted ? <Bell size={18}/> : <BellOff size={18}/>,
        label: chat.muted ? t('chats.rowActions.unmute') : t('chats.rowActions.mute'),
    });
    add(actions.onToggleArchive, {
        key: 'archive',
        icon: chat.archived ? <ArchiveRestore size={18}/> : <Archive size={18}/>,
        label: chat.archived ? t('chats.rowActions.unarchive') : t('chats.rowActions.archive'),
    });
    // A chat already unread has nothing to mark.
    if (chat.unreadCount === 0) {
        add(actions.onMarkUnread, { key: 'unread', icon: <Mail size={18}/>, label: t('chats.rowActions.markUnread') });
    }
    const destructive = [];
    const addDestructive = (handler, item) => {
        if (handler)
            destructive.push({ ...item, run: handler });
    };
    if (group) {
        addDestructive(actions.onLeaveGroup, { key: 'leave', icon: <LogOut size={18}/>, label: t('chats.group.leave') });
    }
    if (direct) {
        const blocked = actions.isBlocked?.(chat) ?? false;
        addDestructive(actions.onToggleBlock, {
            key: 'block',
            icon: blocked ? <ShieldCheck size={18}/> : <Ban size={18}/>,
            label: blocked ? t('chats.rowActions.unblock') : t('chats.rowActions.block'),
        });
        addDestructive(actions.onClear, { key: 'clear', icon: <Eraser size={18}/>, label: t('chats.rowActions.clear') });
        addDestructive(actions.onDelete, {
            key: 'delete',
            icon: <Trash2 size={18}/>,
            label: t('chats.rowActions.delete'),
        });
    }
    if (destructive.length > 0)
        destructive[0].separated = true;
    return [...items, ...destructive];
}
