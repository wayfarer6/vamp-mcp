/** Local lifecycle contract. Host support is checked before constructing an adapter. */
export interface DesktopVM {
  id: string;
  name: string;
  backend: string;
  state: string;
  managed?: boolean;
  memory?: number | string;
  cpus?: number | string;
  guestOS?: string;
}
export interface DesktopAdapter {
  check(): Promise<string>;
  list(): Promise<DesktopVM[]>;
  create(options: Record<string, unknown>): Promise<unknown>;
  start(id: string): Promise<unknown>;
  stop(id: string): Promise<unknown>;
  remove(id: string): Promise<unknown>;
  /** Optional native operations; only adapters with this capability expose them. */
  command?(args: string[]): Promise<string>;
  endpoint?(id: string): Promise<{host: string; port: number}>;
}
