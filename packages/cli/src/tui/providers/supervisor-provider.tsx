import React, { createContext, useContext } from 'react';
import type { RemoteSupervisor } from '@/client/remote-supervisor';

const SupervisorContext = createContext<RemoteSupervisor | null>(null);

export function SupervisorProvider({ supervisor, children }: {
  supervisor: RemoteSupervisor;
  children: React.ReactNode;
}) {
  return (
    <SupervisorContext.Provider value={supervisor}>
      {children}
    </SupervisorContext.Provider>
  );
}

export function useSupervisor(): RemoteSupervisor {
  const ctx = useContext(SupervisorContext);
  if (!ctx) throw new Error('useSupervisor must be used within SupervisorProvider');
  return ctx;
}
