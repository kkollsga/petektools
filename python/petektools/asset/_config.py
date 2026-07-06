"""The planted-truth constants of the synthetic asset — the fictional study area,
the per-zone table, the mixed well program, and the v2 structural fixtures.

These are the *composer's* knobs (the shape of THE suite dataset); the per-format
writers below carry none of them — a writer takes in-memory data + a lattice, so
it can emit ONE surface / ONE well anywhere. Only ``synth_asset`` reads this file.

No confidential data: an arbitrary fictional study area, fictional 99/x-y ids,
every value derived from the seed.
"""

from __future__ import annotations

# --- asset version -----------------------------------------------------------
ASSET_VERSION = 2

# --- study area (arbitrary fictional UTM-magnitude window) --------------------
X0, Y0 = 431_000.0, 6_521_000.0  # the fictional WORLD georef origin (doctrine R1)
INC = 100.0
NCOL = NROW = 41                 # default 4 km square (THE suite dataset)
KB = 30.0                        # kelly bushing, m above MSL
TOP_DATUM = 2_000.0              # regional Top TVDSS at zero relief (positive-down)
DOME_RELIEF = 80.0               # crest-to-flank relief (crest is shallowest)
DOME_ASPECT = 1.6                # elongation
DOME_TILT = 12.0                 # gentle regional tilt (m across the extent)
LOG_STEP = 0.5                   # LAS sample spacing (m)
NET_CUTOFF = 0.10  # owner ruling = petektools DEFAULT_NET_CUTOFF; coupled generator derives net_flag = phie >= cutoff
RHO = 0.6                        # planted collocated correlation (the killer test recovers this)

# Vendor-suffixed mnemonics (exercise the load-time aliasing seam).
MNEM_POR, MNEM_NTG, MNEM_SW = "PHIE_2025", "NTG_PhieLam_2025", "SW_2025"
ALIASES = {MNEM_POR: "PORO", MNEM_NTG: "NTG", MNEM_SW: "SW"}

# Per-zone planted truth: (mean isochore, isochore variability, ntg_target,
# net_por_mean, net_por_std). Two zones carry hydrocarbon (see CONTACT_ZONES).
# ntg_target + net_por_mean are what the net-conditioned upscale must recover.
ZONE_TABLE = [
    # name  mean_iso  iso_sd  ntg    net_por  net_sd
    ("Z0", 15.0, 3.0, 0.35, 0.235, 0.035),
    ("Z1", 12.0, 2.5, 0.55, 0.255, 0.035),
    ("Z2", 18.0, 3.5, 0.70, 0.275, 0.035),   # single OWC (oil)
    ("Z3", 10.0, 2.5, 0.45, 0.240, 0.035),   # carries the tops-only split H3b
    ("Z4", 14.0, 3.0, 0.80, 0.290, 0.035),   # GOC + FWL (gas cap + oil rim)
    ("Z5", 11.0, 2.5, 0.30, 0.225, 0.035),   # PINCHES OUT to zero across the east
]
NONNET_POR_MEAN, NONNET_POR_SD = 0.050, 0.010
BED_SCALE_M, CORR_LEN_M = 1.2, 4.0
NZONE = len(ZONE_TABLE)
NHOR = NZONE + 1                 # H0..H6
HORIZONS = [f"H{k}" for k in range(NHOR)]
ZONES = [z[0] for z in ZONE_TABLE]

# --- v2: the tops-only internal split horizon --------------------------------
# One internal horizon that has well PICKS but NO mapped surface in the emitted
# tree — the conformal-drape case (petekStatic drapes it between its bounding
# mapped horizons). Placed inside Z3 at a fixed depth fraction between H3 and H4.
TOPS_ONLY_HORIZON = "H3b"
TOPS_ONLY_SPLIT = (3, 0.5)       # (upper mapped-horizon index, fraction toward the next)

# --- v2: the pinch-out zone --------------------------------------------------
# Z5's isochore is multiplied by an areal ramp that falls from full thickness
# (west) through a sub-threshold band to EXACTLY zero across the eastern part of
# the extent — genuine degenerate columns (R5 food) the collapse/order-repair
# machinery must survive.
PINCH_ZONE_INDEX = 5
PINCH_FULL_FRAC = 0.55           # i/(ncol-1) below this: full thickness
PINCH_SUB_FRAC = 0.70            # [SUB, ZERO): a SUB-THRESHOLD band (thin, non-zero)
PINCH_ZERO_FRAC = 0.80           # i/(ncol-1) at/above this: exactly zero
PINCH_SUB_MULT = 0.03            # isochore multiplier at the top of the sub-threshold band
PINCH_SUBTHRESHOLD_M = 0.5       # thickness under this counts as a sub-threshold column

# --- v2: mixed well program --------------------------------------------------
# The last N_DEVIATED wells are directional; the rest vertical (v1 behaviour). A
# deviated bore kicks off ABOVE the reservoir, builds toward the field centre, and
# holds through the reservoir so it crosses several 100 m columns at depth. Each
# entry: (profile, hold_incl_deg, build_rate_deg_per_30m, final_incl_deg_or_None).
DEVIATED_PROGRAM = [
    ("build_hold", 68.0, 4.0, None),        # a strongly-deviated producer (high angle in-reservoir)
    ("build_hold_drop", 64.0, 4.0, 40.0),   # an S-well (build, hold, drop back)
    ("build_hold", 60.0, 4.0, None),        # a gentler deviated bore
]

# The synthetic CRS label stamped into the well-path headers + returned manifest.
CRS = "SYNTHETIC / ED50 UTM zone 31N"
