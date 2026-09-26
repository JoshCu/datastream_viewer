// Live Muskingum-Cunge routing over the reaches currently loaded on the map.
//
// A `Network` holds every reach as struct-of-arrays columns in wasm linear
// memory, physically ordered upstream-first so one `step()` is a single linear
// sweep: each reach routes its accumulated upstream inflow and pushes its own
// outflow into its downstream neighbour, which runs later in the same sweep.
//
// JS reads `q` / `velocity` / `depth` and writes `qlat` through zero-copy
// typed-array views over the exported pointers. Those views detach whenever
// wasm memory grows, which only `build()` can cause (step/collect_dirty never
// allocate), so JS recreates them after every build.
use rustc_hash::FxHashMap;
use wasm_bindgen::prelude::*;

mod kernel;
use kernel::muskingum_cunge;

/// Local index meaning "the downstream reach is not in this network".
const NONE: u32 = u32::MAX;

/// Outflow below this snaps to zero. Flows decay asymptotically, so without
/// it everything downstream of a deposit would keep iterating the secant
/// solver forever instead of hitting the kernel's dry early exit.
const Q_SNAP: f32 = 1e-4;

#[cfg(feature = "debug")]
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct Network {
    ids: Vec<u32>, // local index -> wb id (upstream-first order)
    ds: Vec<u32>,  // local downstream index, NONE = off-screen / outlet
    dx: Vec<f32>,
    mann_n: Vec<f32>,
    ncc: Vec<f32>,
    s0: Vec<f32>,
    bw: Vec<f32>,
    tw: Vec<f32>,
    twcc: Vec<f32>,
    cs: Vec<f32>,
    q: Vec<f32>,
    qup: Vec<f32>,
    velocity: Vec<f32>,
    depth: Vec<f32>,
    inflow: Vec<f32>,
    qlat: Vec<f32>,
    painted: Vec<f32>, // last q handed to feature-state
    dirty: Vec<u32>,   // capacity == len, so collect_dirty never reallocates
    orphans: Vec<u32>, // wb ids painted by `prev` that this network dropped
    dt: f32,
    qlat_decay: f32,
}

/// `v` when it is a usable positive number, else `fallback`. Catches NaN too,
/// because the kernel panics (a wasm trap that kills the instance) on
/// non-positive n / s0 / cs / bw.
fn positive(v: f32, fallback: f32) -> f32 {
    if v.is_finite() && v > 0.0 { v } else { fallback }
}

#[wasm_bindgen]
impl Network {
    /// Build a network from per-reach columns (all the same length).
    ///
    /// Reaches are sorted by `upstream_ids` descending, which is a valid
    /// upstream-first order because the hydrofabric's upstream_id is a
    /// nested-set (DFS preorder) index. `toids` holds the downstream wb id; a
    /// toid not in `ids` means the flow leaves the network. Duplicate ids keep
    /// their first occurrence.
    ///
    /// State (q, qup, depth, velocity, qlat) carries over from `prev` by wb id,
    /// so rebuilding on pan/zoom doesn't lose water. `prev` is consumed.
    #[allow(clippy::too_many_arguments)]
    pub fn build(
        ids: &[u32],
        toids: &[u32],
        upstream_ids: &[u32],
        dx: &[f32],
        mann_n: &[f32],
        ncc: &[f32],
        s0: &[f32],
        bw: &[f32],
        tw: &[f32],
        twcc: &[f32],
        cs: &[f32],
        dt: f32,
        prev: Option<Network>,
    ) -> Result<Network, String> {
        let len = ids.len();
        let columns = [
            toids.len(),
            upstream_ids.len(),
            dx.len(),
            mann_n.len(),
            ncc.len(),
            s0.len(),
            bw.len(),
            tw.len(),
            twcc.len(),
            cs.len(),
        ];
        if columns.iter().any(|&l| l != len) {
            return Err(format!("column lengths differ: ids {len}, others {columns:?}"));
        }
        if !(dt.is_finite() && dt > 0.0) {
            return Err(format!("dt must be positive, got {dt}"));
        }

        let mut order: Vec<usize> = (0..len).collect();
        order.sort_unstable_by(|&a, &b| {
            upstream_ids[b].cmp(&upstream_ids[a]).then(ids[a].cmp(&ids[b]))
        });
        let mut seen = FxHashMap::default();
        seen.reserve(len);
        order.retain(|&src| seen.insert(ids[src], ()).is_none());
        let n = order.len();

        let mut local: FxHashMap<u32, u32> = FxHashMap::default();
        local.reserve(n);
        for (i, &src) in order.iter().enumerate() {
            local.insert(ids[src], i as u32);
        }

        let pick = |col: &[f32], f: &dyn Fn(f32, usize) -> f32| -> Vec<f32> {
            order.iter().map(|&src| f(col[src], src)).collect()
        };
        let mann_n_v = pick(mann_n, &|v, _| positive(v, 0.06));
        let mut net = Network {
            ids: order.iter().map(|&src| ids[src]).collect(),
            ds: order
                .iter()
                .map(|&src| local.get(&toids[src]).copied().unwrap_or(NONE))
                .collect(),
            dx: pick(dx, &|v, _| if v.is_finite() { v.max(10.0) } else { 1000.0 }),
            ncc: order
                .iter()
                .enumerate()
                .map(|(i, &src)| positive(ncc[src], mann_n_v[i] * 2.0))
                .collect(),
            mann_n: mann_n_v,
            // rs_route's network.rs clamps a zero slope the same way.
            s0: pick(s0, &|v, _| positive(v, 0.00001)),
            bw: pick(bw, &|v, _| positive(v, 1.0)),
            tw: pick(tw, &|v, src| {
                if v.is_finite() && v >= 0.0 { v } else { positive(bw[src], 1.0) }
            }),
            twcc: pick(twcc, &|v, _| if v.is_finite() && v >= 0.0 { v } else { 0.0 }),
            cs: pick(cs, &|v, _| positive(v, 0.5)),
            q: vec![0.0; n],
            qup: vec![0.0; n],
            velocity: vec![0.0; n],
            depth: vec![0.0; n],
            inflow: vec![0.0; n],
            qlat: vec![0.0; n],
            painted: vec![0.0; n],
            dirty: Vec::with_capacity(n),
            orphans: Vec::new(),
            dt,
            qlat_decay: 1.0,
        };

        if let Some(prev) = prev {
            net.qlat_decay = prev.qlat_decay;
            for (p, &id) in prev.ids.iter().enumerate() {
                match local.get(&id) {
                    Some(&i) => {
                        let i = i as usize;
                        net.q[i] = prev.q[p];
                        net.qup[i] = prev.qup[p];
                        net.velocity[i] = prev.velocity[p];
                        net.depth[i] = prev.depth[p];
                        net.qlat[i] = prev.qlat[p];
                        net.painted[i] = prev.painted[p];
                    }
                    // Its feature-state still shows water; JS clears it so a
                    // reach that later re-enters as fresh-and-dry isn't stale.
                    None if prev.painted[p] != 0.0 => net.orphans.push(id),
                    None => {}
                }
            }
        }
        Ok(net)
    }

    pub fn len(&self) -> usize {
        self.ids.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }

    pub fn dt(&self) -> f32 {
        self.dt
    }

    /// Per-step multiplier on qlat, so brush deposits fade out.
    pub fn set_qlat_decay(&mut self, decay: f32) {
        self.qlat_decay = decay.clamp(0.0, 1.0);
    }

    /// Advance every reach by `steps` timesteps of `dt`.
    pub fn step(&mut self, steps: u32) {
        let n = self.ids.len();
        for _ in 0..steps {
            for i in 0..n {
                let quc = self.inflow[i];
                self.inflow[i] = 0.0;
                let r = muskingum_cunge(
                    self.qup[i],
                    quc,
                    self.q[i],
                    self.qlat[i],
                    self.dt,
                    self.s0[i],
                    self.dx[i],
                    self.mann_n[i],
                    self.cs[i],
                    self.bw[i],
                    self.tw[i],
                    self.twcc[i],
                    self.ncc[i],
                    self.depth[i],
                    false,
                );
                self.qup[i] = quc;
                if r.qdc < Q_SNAP {
                    self.q[i] = 0.0;
                    self.velocity[i] = 0.0;
                    self.depth[i] = 0.0;
                } else {
                    self.q[i] = r.qdc;
                    self.velocity[i] = r.velc;
                    self.depth[i] = r.depthc;
                }
                let ds = self.ds[i];
                if ds != NONE {
                    self.inflow[ds as usize] += self.q[i];
                }
                self.qlat[i] *= self.qlat_decay;
            }
        }
    }

    /// Record the reaches whose q moved more than `eps` since they were last
    /// painted (NaN-safe), mark them painted, and return how many there are.
    /// Read them through `dirty_ptr()`.
    pub fn collect_dirty(&mut self, eps: f32) -> usize {
        self.dirty.clear();
        for i in 0..self.ids.len() {
            let q = self.q[i];
            let delta = (q - self.painted[i]).abs();
            if delta > eps || delta.is_nan() {
                self.painted[i] = q;
                self.dirty.push(i as u32);
            }
        }
        self.dirty.len()
    }

    /// Mark every reach as needing a repaint on the next collect_dirty().
    pub fn invalidate_painted(&mut self) {
        self.painted.fill(f32::NAN);
    }

    /// Zero all water (flows, depths, lateral inflow) without rebuilding.
    pub fn reset(&mut self) {
        for col in [
            &mut self.q,
            &mut self.qup,
            &mut self.velocity,
            &mut self.depth,
            &mut self.inflow,
            &mut self.qlat,
        ] {
            col.fill(0.0);
        }
    }

    /// Wb ids that `prev` had painted with water but this network dropped.
    /// Drains the list.
    pub fn take_orphans(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.orphans)
    }

    pub fn ids_ptr(&self) -> *const u32 {
        self.ids.as_ptr()
    }
    pub fn q_ptr(&self) -> *const f32 {
        self.q.as_ptr()
    }
    pub fn velocity_ptr(&self) -> *const f32 {
        self.velocity.as_ptr()
    }
    pub fn depth_ptr(&self) -> *const f32 {
        self.depth.as_ptr()
    }
    pub fn qlat_ptr(&mut self) -> *mut f32 {
        self.qlat.as_mut_ptr()
    }
    pub fn dirty_ptr(&self) -> *const u32 {
        self.dirty.as_ptr()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 3-reach chain 30 -> 20 -> 10, handed over in scrambled order.
    fn chain(prev: Option<Network>) -> Network {
        let ids = [20, 10, 30];
        let toids = [10, 999, 20];
        let upstream_ids = [2, 1, 3];
        let f = |v: f32| vec![v; 3];
        Network::build(
            &ids, &toids, &upstream_ids, &f(1000.0), &f(0.06), &f(0.12), &f(0.001), &f(2.0),
            &f(5.0), &f(15.0), &f(0.5), 300.0, prev,
        )
        .unwrap()
    }

    #[test]
    fn sorts_upstream_first_and_resolves_downstream() {
        let net = chain(None);
        assert_eq!(net.ids, [30, 20, 10]);
        assert_eq!(net.ds, [1, 2, NONE]);
    }

    #[test]
    fn water_flows_downstream_and_carries_over() {
        let mut net = chain(None);
        net.qlat[0] = 5.0;
        net.step(20);
        assert!(net.q.iter().all(|&q| q > 0.0), "{:?}", net.q);

        let q_before = net.q[2];
        let net = chain(Some(net));
        assert_eq!(net.q[2], q_before);
        assert!(net.orphans.is_empty());
    }

    #[test]
    fn invalid_params_are_clamped_not_panicking() {
        let z = vec![0.0; 3];
        let nan = vec![f32::NAN; 3];
        let mut net = Network::build(
            &[1, 2, 3], &[2, 3, 0], &[3, 2, 1], &z, &nan, &z, &z, &z, &nan, &z, &z, 300.0, None,
        )
        .unwrap();
        net.qlat.fill(1.0);
        net.step(5);
        assert!(net.q.iter().all(|q| q.is_finite()));
    }

    #[test]
    fn dirty_tracks_changes() {
        let mut net = chain(None);
        assert_eq!(net.collect_dirty(0.01), 0);
        net.qlat[0] = 5.0;
        net.step(1);
        assert!(net.collect_dirty(0.01) > 0);
        assert_eq!(net.collect_dirty(0.01), 0);
    }
}
