// Vendored Muskingum-Cunge kernel.
//
// Source: rs_route (https://github.com/CIROH-UA/rs_route)
//   src/kernel/muskingum/rs_route/mc_kernel.rs @ 1ed548a
//   plus MuskingumCungeResult from src/kernel/muskingum/mod.rs @ 1ed548a
//
// Copied verbatim apart from inlining the result struct (and dropping its
// `use` / `#[repr(C)]`) and replacing `x.powf(2.0 / 3.0)` with `pow23(x)`:
// wasm has no pow instruction, so powf is a software libm call, and it sat in
// the secant loop's hot path (~30% of a wet reach's cost). Re-copy by hand when
// upstream changes (redoing that substitution); the parity test at the bottom
// of this file catches drift or copy mistakes.
#![allow(clippy::too_many_arguments, non_snake_case, unused)]

/// Universal MC Result struct
#[derive(Default, Debug)]
pub struct MuskingumCungeResult {
    /// flow downstream current timestep
    pub qdc: f32,
    /// channel velocity
    pub velc: f32,
    /// depth of flow in channel
    pub depthc: f32,
    /// wave celerity
    pub ck: f32,
    /// courant number
    pub cn: f32,
    /// Muskingum X
    pub x: f32,
}

/// Pure Rust Muskingum-Cunge routing implementation.
///
/// Closely follows the Fortran t-route `secant2_h` / `muskingum_cunge` structure:
///   - Interval 1 (h_0) computes X using the previous iteration's Qj_0
///     (initialized to 0.0 on first iteration, matching uninitialized Fortran behavior).
///   - Interval 2 (h) computes X using C1-C4 from interval 1.
///   - C1-C4 are then recomputed for interval 2 with the correct X.
pub fn muskingum_cunge(
    qup: f32,                // flow upstream previous timestep
    quc: f32,                // flow upstream current timestep
    qdp: f32,                // flow downstream previous timestep
    ql: f32,                 // lateral inflow through reach (m^3/sec)
    dt: f32,                 // routing period in seconds
    so: f32,                 // channel bottom slope (as fraction, not %)
    dx: f32,                 // channel length (m)
    n: f32,                  // mannings coefficient
    cs: f32,                 // channel side slope
    bw: f32,                 // bottom width (meters)
    tw: f32,                 // top width before bankfull (meters)
    tw_cc: f32,              // top width of compound (meters)
    n_cc: f32,               // mannings of compound
    depth_p: f32,            // depth of flow in channel
    calculate_courant: bool, // whether to calculate courant number
) -> MuskingumCungeResult {
    // early exit if no flow
    if qdp <= 0.0 && ql <= 0.0 && qup <= 0.0 && quc <= 0.0 {
        return MuskingumCungeResult::default();
    }

    // Precompute constants
    let z = if cs == 0.0 { 1.0 } else { 1.0 / cs };
    let sqrt_1_z2 = (1.0 + z * z).sqrt();
    let sqrt_so = so.sqrt();
    let sqrt_so_n = sqrt_so / n;
    let sqrt_so_ncc = sqrt_so / n_cc;
    let dt_half = dt * 0.5;

    let bfd = if bw > tw {
        bw / 0.00001
    } else if bw == tw {
        bw / (2.0 * z)
    } else {
        (tw - bw) / (2.0 * z)
    };

    if n <= 0.0 || so <= 0.0 || z <= 0.0 || bw <= 0.0 {
        panic!("Error in channel coefficients");
    }

    let mut depthc = depth_p.max(0.0);

    let mut h = (depthc * 1.33) + 0.01;
    let mut h_0 = depthc * 0.67;
    let mut tries = 0;
    let mut maxiter = 100;
    let mindepth = 0.01;

    // These persist across both intervals and across iterations,
    // matching the Fortran where C1-C4, X, Qj_0 are shared mutable state.
    let mut c1: f32 = 0.0;
    let mut c2: f32 = 0.0;
    let mut c3: f32 = 0.0;
    let mut c4: f32 = 0.0;
    let mut x: f32 = 0.0;
    // Matches Fortran's uninitialized local (gfortran typically zero-initializes)
    let mut qj_0: f32 = 0.0;

    // Precompute for bankfull conditions
    let bw_2bfd_z = bw + 2.0 * bfd * z;
    let two_sqrt_1_z2 = 2.0 * sqrt_1_z2;

    'outer: loop {
        let mut iter = 0;
        let mut rerror = 1.0;
        let mut aerror = 0.01;

        while rerror > 0.01 && aerror >= mindepth && iter <= maxiter {
            // === Interval 1: secant2_h(h_0, interval=1) ===
            // Matches Fortran: X uses previous qj_0, then computes C1-C4 and new qj_0
            let twl_0 = bw + 2.0 * z * h_0;

            let (area_0, area_c_0, wp_0, wp_c_0, r_0) =
                hydraulic_geometry(h_0, bfd, bw, tw_cc, z, sqrt_1_z2);

            let r_0_2_3 = pow23(r_0);
            let r_0_5_3 = r_0 * r_0_2_3;

            let ck_0 = kinematic_celerity(
                h_0,
                bfd,
                tw_cc,
                n_cc,
                r_0_2_3,
                r_0_5_3,
                area_0,
                area_c_0,
                sqrt_so_n,
                sqrt_so_ncc,
                two_sqrt_1_z2,
                bw_2bfd_z,
                bw,
                z,
            );

            let km_0 = if ck_0 > 0.0 { dt.max(dx / ck_0) } else { dt };

            // X for interval 1: uses previous iteration's qj_0 (0.0 on first iter)
            let x_0 = if h_0 > bfd && tw_cc > 0.0 && n_cc > 0.0 && ck_0 > 0.0 {
                (0.5 * (1.0 - qj_0 / (2.0 * tw_cc * so * ck_0 * dx))).clamp(0.0, 0.5)
            } else if ck_0 > 0.0 {
                (0.5 * (1.0 - qj_0 / (2.0 * twl_0 * so * ck_0 * dx))).clamp(0.0, 0.5)
            } else {
                0.5
            };

            // Compute C1-C4 for interval 1 (these will be read by interval 2)
            let d_0 = km_0 * (1.0 - x_0) + dt_half;
            c1 = (km_0 * x_0 + dt_half) / d_0;
            c2 = (dt_half - km_0 * x_0) / d_0;
            c3 = (km_0 * (1.0 - x_0) - dt_half) / d_0;
            c4 = (ql * dt) / d_0;

            // Compute Qj_0 output
            qj_0 = if wp_0 + wp_c_0 > 0.0 {
                let manning_avg = ((wp_0 * n) + (wp_c_0 * n_cc)) / (wp_0 + wp_c_0);
                (c1 * qup + c2 * quc + c3 * qdp + c4)
                    - ((1.0 / manning_avg) * (area_0 + area_c_0) * r_0_2_3 * sqrt_so)
            } else {
                0.0
            };

            // === Interval 2: secant2_h(h, interval=2) ===
            // Matches Fortran: X uses C1-C4 from interval 1, then recomputes C1-C4
            let twl = bw + 2.0 * z * h;

            let (area, area_c, wp, wp_c, r) = hydraulic_geometry(h, bfd, bw, tw_cc, z, sqrt_1_z2);

            let r_2_3 = pow23(r);
            let r_5_3 = r * r_2_3;

            let ck = kinematic_celerity(
                h,
                bfd,
                tw_cc,
                n_cc,
                r_2_3,
                r_5_3,
                area,
                area_c,
                sqrt_so_n,
                sqrt_so_ncc,
                two_sqrt_1_z2,
                bw_2bfd_z,
                bw,
                z,
            );

            let km = if ck > 0.0 { dt.max(dx / ck) } else { dt };

            // X for interval 2: uses C1-C4 from interval 1 (the key coupling)
            let flow_sum_from_interval_1 = c1 * qup + c2 * quc + c3 * qdp + c4;
            x = if h > bfd && tw_cc > 0.0 && n_cc > 0.0 && ck > 0.0 {
                (0.5 * (1.0 - flow_sum_from_interval_1 / (2.0 * tw_cc * so * ck * dx)))
                    .clamp(0.25, 0.5)
            } else if ck > 0.0 {
                (0.5 * (1.0 - flow_sum_from_interval_1 / (2.0 * twl * so * ck * dx)))
                    .clamp(0.25, 0.5)
            } else {
                0.5
            };

            // Recompute C1-C4 with interval 2's own Km and X
            let d = km * (1.0 - x) + dt_half;
            c1 = (km * x + dt_half) / d;
            c2 = (dt_half - km * x) / d;
            c3 = (km * (1.0 - x) - dt_half) / d;
            c4 = (ql * dt) / d;

            // C4 adjustment (interval 2 only, matching Fortran)
            if c4 < 0.0 && c4.abs() > (c1 * qup + c2 * quc + c3 * qdp) {
                c4 = -(c1 * qup + c2 * quc + c3 * qdp);
            }

            // Compute Qj output
            let qj = if wp + wp_c > 0.0 {
                let manning_avg = ((wp * n) + (wp_c * n_cc)) / (wp + wp_c);
                (c1 * qup + c2 * quc + c3 * qdp + c4)
                    - ((1.0 / manning_avg) * (area + area_c) * r_2_3 * sqrt_so)
            } else {
                0.0
            };

            // Secant method update (Fortran uses exact != 0.0 comparison)
            let h_1 = if qj_0 - qj != 0.0 {
                let h_new = h - (qj * (h_0 - h) / (qj_0 - qj));
                if h_new < 0.0 { h } else { h_new }
            } else {
                h
            };

            if h > 0.0 {
                rerror = ((h_1 - h) / h).abs();
                aerror = (h_1 - h).abs();
            } else {
                rerror = 0.0;
                aerror = 0.9;
            }

            h_0 = h.max(0.0);
            h = h_1.max(0.0);
            iter += 1;

            if h < mindepth {
                break;
            }
        }

        if iter >= maxiter {
            tries += 1;
            if tries <= 4 {
                h *= 1.33;
                h_0 *= 0.67;
                maxiter += 25;
                continue 'outer;
            }
            eprintln!("Musk Cunge WARNING: Failure to converge");
        }
        break;
    }

    // Calculate final flow
    let flow_sum = c1 * qup + c2 * quc + c3 * qdp + c4;
    let qdc = if flow_sum < 0.0 {
        if c4 < 0.0 && c4.abs() > (c1 * qup + c2 * quc + c3 * qdp) {
            0.0
        } else {
            (c1 * qup + c2 * quc + c4).max(c1 * qup + c3 * qdp + c4)
        }
    } else {
        flow_sum
    };

    // Calculate velocity
    let twl = bw + 2.0 * z * h;
    let r = (h * (bw + twl) * 0.5) / (bw + 2.0 * (((twl - bw) * 0.5).powi(2) + h.powi(2)).sqrt());
    let velc = (1.0 / n) * pow23(r) * sqrt_so;
    depthc = h;

    // Calculate Courant number
    let (ck, cn) = if depthc > 0.0 && calculate_courant {
        let mut h_gt_bf = (depthc - bfd).max(0.0);
        let mut h_lt_bf = bfd.min(depthc);

        if h_gt_bf > 0.0 && tw_cc <= 0.0 {
            h_gt_bf = 0.0;
            h_lt_bf = depthc;
        }

        let area = (bw + h_lt_bf * z) * h_lt_bf;
        let wp = bw + 2.0 * h_lt_bf * sqrt_1_z2;
        let area_c = tw_cc * h_gt_bf;
        let wp_c = if h_gt_bf > 0.0 {
            tw_cc + 2.0 * h_gt_bf
        } else {
            0.0
        };
        let r = (area + area_c) / (wp + wp_c);

        let r_2_3 = pow23(r);
        let r_5_3 = r * r_2_3;

        let ck = ((sqrt_so_n
            * ((5.0 / 3.0) * r_2_3
                - (2.0 / 3.0) * r_5_3 * (two_sqrt_1_z2 / (bw + 2.0 * h_lt_bf * z)))
            * area
            + sqrt_so_ncc * (5.0 / 3.0) * pow23(h_gt_bf) * area_c)
            / (area + area_c))
            .max(0.0);

        (ck, ck * (dt / dx))
    } else {
        (0.0, 0.0)
    };
    MuskingumCungeResult {
        qdc,
        velc,
        depthc,
        ck,
        cn,
        x,
    }
}

/// Compute hydraulic geometry for a given depth h.
/// Matches the Fortran `hydraulic_geometry` subroutine.
#[inline]
fn hydraulic_geometry(
    h: f32,
    bfd: f32,
    bw: f32,
    tw_cc: f32,
    z: f32,
    sqrt_1_z2: f32,
) -> (f32, f32, f32, f32, f32) {
    if h > bfd && tw_cc > 0.0 {
        let h_gt_bf = h - bfd;
        let area = (bw + bfd * z) * bfd;
        let area_c = tw_cc * h_gt_bf;
        let wp = bw + 2.0 * bfd * sqrt_1_z2;
        let wp_c = tw_cc + 2.0 * h_gt_bf;
        let r = (area + area_c) / (wp + wp_c);
        (area, area_c, wp, wp_c, r)
    } else {
        let area = (bw + h * z) * h;
        let wp = bw + 2.0 * h * sqrt_1_z2;
        let r = if wp > 0.0 { area / wp } else { 0.0 };
        (area, 0.0, wp, 0.0, r)
    }
}

/// Compute kinematic celerity Ck.
/// Matches the celerity computation in Fortran `secant2_h`.
#[inline]
#[allow(clippy::too_many_arguments)]
fn kinematic_celerity(
    h: f32,
    bfd: f32,
    tw_cc: f32,
    n_cc: f32,
    r_2_3: f32,
    r_5_3: f32,
    area: f32,
    area_c: f32,
    sqrt_so_n: f32,
    sqrt_so_ncc: f32,
    two_sqrt_1_z2: f32,
    bw_2bfd_z: f32,
    bw: f32,
    z: f32,
) -> f32 {
    if h > bfd && tw_cc > 0.0 && n_cc > 0.0 {
        ((sqrt_so_n
            * ((5.0 / 3.0) * r_2_3 - (2.0 / 3.0) * r_5_3 * (two_sqrt_1_z2 / bw_2bfd_z))
            * area
            + sqrt_so_ncc * (5.0 / 3.0) * (h - bfd).powf(2.0 / 3.0) * area_c)
            / (area + area_c))
            .max(0.0)
    } else if h > 0.0 {
        (sqrt_so_n
            * ((5.0 / 3.0) * r_2_3 - (2.0 / 3.0) * r_5_3 * (two_sqrt_1_z2 / (bw + 2.0 * h * z))))
            .max(0.0)
    } else {
        0.0
    }
}

/// `x^(2/3)` for `x >= 0` (0 for non-positive `x`) without libm: a bit-trick
/// cube-root seed refined by three Newton steps, then squared. Accurate to f32
/// rounding for the positive, normal radii and depths the kernel feeds it.
#[inline(always)]
fn pow23(x: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }
    let mut y = f32::from_bits(x.to_bits() / 3 + 709_921_077);
    for _ in 0..3 {
        y = (2.0 * y + x / (y * y)) * (1.0 / 3.0);
    }
    y * y
}

#[cfg(test)]
mod tests {
    use super::muskingum_cunge;

    // Generated by compiling rs_route's mc_kernel.rs @ 1ed548a natively and
    // calling it with calculate_courant = true.
    // Inputs: qup, quc, qdp, ql, dt, s0, dx, n, cs, bw, tw, twcc, ncc, depth_p
    // Outputs: qdc, velc, depthc
    #[rustfmt::skip]
    const CASES: &[(&[f32; 14], [f32; 3])] = &[
        (&[0.0, 0.0, 0.0, 0.0, 300.0, 0.001, 1000.0, 0.06, 0.5, 2.0, 5.0, 15.0, 0.12, 0.0], [0.0, 0.0, 0.0]),
        (&[0.0, 0.0, 0.0, 1.0, 300.0, 0.001, 1000.0, 0.06, 0.5, 2.0, 5.0, 15.0, 0.12, 0.0], [0.01590945, 0.02451537, 0.010156607]),
        (&[1.0, 2.0, 0.5, 0.1, 300.0, 0.001, 2500.0, 0.055, 0.6, 5.3, 12.0, 36.0, 0.11, 0.3], [1.4598178, 0.2883094, 0.409]),
        (&[10.0, 12.0, 9.0, 0.5, 300.0, 0.0005, 4000.0, 0.05, 0.7, 11.0, 25.0, 75.0, 0.1, 0.8], [7.8899913, 0.46977457, 1.3008901]),
        (&[150.0, 400.0, 120.0, 5.0, 300.0, 0.0002, 6000.0, 0.045, 0.8, 26.0, 60.0, 180.0, 0.09, 1.5], [262.12833, 0.4586392, 2.005]),
        (&[5.0, 5.0, 5.0, 0.0, 3600.0, 0.01, 500.0, 0.07, 0.4, 1.6, 4.0, 12.0, 0.14, 0.2], [4.9999995, 1.0822753, 1.1480155]),
        (&[3.0, 1.0, 4.0, -2.0, 300.0, 0.001, 1500.0, 0.06, 0.5, 3.0, 7.0, 21.0, 0.12, 0.4], [4.865847, 0.42854217, 1.1207552]),
        (&[2.0, 3.0, 1.0, 0.2, 300.0, 0.002, 800.0, 0.06, 0.5, 6.0, 4.0, 0.0, 0.12, 0.1], [0.5257654, 0.19652289, 0.143]),
        (&[2.0, 3.0, 1.0, 0.2, 300.0, 0.002, 800.0, 0.06, 0.5, 4.0, 4.0, 12.0, 0.12, 0.1], [0.5398898, 0.19333369, 0.143]),
        (&[800.0, 2500.0, 700.0, 20.0, 300.0, 0.0001, 10000.0, 0.04, 0.9, 110.0, 250.0, 750.0, 0.08, 4.0], [1454.8304, 0.7218354, 5.3300004]),
    ];

    #[test]
    fn parity_with_rs_route() {
        for (c, want) in CASES {
            let r = muskingum_cunge(
                c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8], c[9], c[10], c[11], c[12],
                c[13], true,
            );
            for (got, want) in [r.qdc, r.velc, r.depthc].iter().zip(want) {
                let tol = 1e-6 * want.abs().max(1.0);
                assert!((got - want).abs() <= tol, "{c:?}: got {got}, want {want}");
            }
        }
    }
}
