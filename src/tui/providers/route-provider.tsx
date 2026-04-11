import React, { createContext, useContext, useState } from 'react';
import { useMemoizedFn } from '@/tui/hooks/use-memoized-fn';

type Route = { page: 'controller' } | { page: 'worker'; workerId: string };

const RouteContext = createContext<{
  route: Route;
  navigate: (route: Route) => void;
}>({
  route: { page: 'controller' },
  navigate: () => { },
});

export function RouteProvider({ children }: { children: React.ReactNode }) {
  const [route, setRoute] = useState<Route>({ page: 'controller' });
  const navigate = useMemoizedFn((r: Route) => setRoute(r));

  return (
    <RouteContext.Provider value={{ route, navigate }}>
      {children}
    </RouteContext.Provider>
  );
}

export function useRouter() {
  return useContext(RouteContext);
}
