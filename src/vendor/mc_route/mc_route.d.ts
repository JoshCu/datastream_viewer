/* tslint:disable */
/* eslint-disable */

export class Network {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Build a network from per-reach columns (all the same length).
     *
     * Reaches are sorted by `upstream_ids` descending, which is a valid
     * upstream-first order because the hydrofabric's upstream_id is a
     * nested-set (DFS preorder) index. `toids` holds the downstream wb id; a
     * toid not in `ids` means the flow leaves the network. Duplicate ids keep
     * their first occurrence.
     *
     * State (q, qup, depth, velocity, qlat) carries over from `prev` by wb id,
     * so rebuilding on pan/zoom doesn't lose water. `prev` is consumed.
     */
    static build(ids: Uint32Array, toids: Uint32Array, upstream_ids: Uint32Array, dx: Float32Array, mann_n: Float32Array, ncc: Float32Array, s0: Float32Array, bw: Float32Array, tw: Float32Array, twcc: Float32Array, cs: Float32Array, dt: number, prev?: Network | null): Network;
    /**
     * Record the reaches whose q moved more than `eps` since they were last
     * painted (NaN-safe), mark them painted, and return how many there are.
     * Read them through `dirty_ptr()`.
     */
    collect_dirty(eps: number): number;
    depth_ptr(): number;
    dirty_ptr(): number;
    dt(): number;
    ids_ptr(): number;
    /**
     * Mark every reach as needing a repaint on the next collect_dirty().
     */
    invalidate_painted(): void;
    is_empty(): boolean;
    len(): number;
    q_ptr(): number;
    qlat_ptr(): number;
    /**
     * Zero all water (flows, depths, lateral inflow) without rebuilding.
     */
    reset(): void;
    /**
     * Per-step multiplier on qlat, so brush deposits fade out.
     */
    set_qlat_decay(decay: number): void;
    /**
     * Advance every reach by `steps` timesteps of `dt`.
     */
    step(steps: number): void;
    /**
     * Wb ids that `prev` had painted with water but this network dropped.
     * Drains the list.
     */
    take_orphans(): Uint32Array;
    velocity_ptr(): number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_network_free: (a: number, b: number) => void;
    readonly network_build: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number) => [number, number, number];
    readonly network_collect_dirty: (a: number, b: number) => number;
    readonly network_depth_ptr: (a: number) => number;
    readonly network_dirty_ptr: (a: number) => number;
    readonly network_dt: (a: number) => number;
    readonly network_ids_ptr: (a: number) => number;
    readonly network_invalidate_painted: (a: number) => void;
    readonly network_is_empty: (a: number) => number;
    readonly network_len: (a: number) => number;
    readonly network_q_ptr: (a: number) => number;
    readonly network_qlat_ptr: (a: number) => number;
    readonly network_reset: (a: number) => void;
    readonly network_set_qlat_decay: (a: number, b: number) => void;
    readonly network_step: (a: number, b: number) => void;
    readonly network_take_orphans: (a: number) => [number, number];
    readonly network_velocity_ptr: (a: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
