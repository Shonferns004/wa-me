import { User, Users, Megaphone, CircleDashed } from 'lucide-react';
function KindIcon({ kind, size = 20, strokeWidth }) {
    if (kind === 'group' || kind === 'broadcast')
        return <Users size={size} strokeWidth={strokeWidth}/>;
    if (kind === 'channel')
        return <Megaphone size={size} strokeWidth={strokeWidth}/>;
    if (kind === 'status')
        return <CircleDashed size={size} strokeWidth={strokeWidth}/>;
    return <User size={size} strokeWidth={strokeWidth}/>;
}
export default KindIcon;
