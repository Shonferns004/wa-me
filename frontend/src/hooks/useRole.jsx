import { createContext, useContext } from 'react';
export const RoleContext = createContext(undefined);
export function useRole() {
    const context = useContext(RoleContext);
    if (context === undefined) {
        throw new Error('useRole must be used within a RoleProvider');
    }
    return context;
}
