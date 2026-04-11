import React, { createContext, useContext } from 'react';
import type { Supervisor } from '@/services/supervisor';

const SupervisorContext = createContext<Supervisor | null>(null);

export function SupervisorProvider({ supervisor, children }: {
  supervisor: Supervisor;
  children: React.ReactNode;
}) {
  return (
    <SupervisorContext.Provider value={supervisor}>
      {children}
    </SupervisorContext.Provider>
  );
}

export function useSupervisor(): Supervisor {
  const ctx = useContext(SupervisorContext);
  if (!ctx) throw new Error('useSupervisor must be used within SupervisorProvider');
  return ctx;
}
