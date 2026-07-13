#!/usr/bin/env python3
"""Reproducible multi-attribute surface payload build/retention benchmark."""

from __future__ import annotations

import argparse
import gc
import json
import math
import time
import tracemalloc

from petektools.viewer import view2d_payload


class AttributeSurface:
    kind = "surface"
    name = "Benchmark surface"

    def __init__(self, grid: int, lanes: int):
        self.grid = grid
        self.lanes = lanes

    def attr_names(self):
        return [f"attribute_{index}" for index in range(1, self.lanes)]

    def value_layer(self, attr=None, stride=None):
        n = self.grid if not stride else (self.grid + stride - 1) // stride
        nodes = [[float(i), float(j)] for j in range(n) for i in range(n)]
        triangles = []
        for j in range(n - 1):
            for i in range(n - 1):
                a = j * n + i
                triangles.extend(([a, a + 1, a + n], [a + 1, a + n + 1, a + n]))
        lane = 0 if attr is None else int(attr.rsplit("_", 1)[1])
        values = [lane + math.sin(index * 0.01) for index in range(n * n)]
        return {"name": attr or "values", "nodes": nodes, "triangles": triangles,
                "values": values, "range": [lane - 1.0, lane + 1.0]}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--grid", type=int, default=198)
    parser.add_argument("--lanes", type=int, nargs="+", default=[1, 2, 4, 8])
    parser.add_argument("--lod", action="store_true")
    args = parser.parse_args()
    results = []
    for lanes in args.lanes:
        gc.collect()
        tracemalloc.start()
        start = time.perf_counter()
        payload = view2d_payload(
            AttributeSurface(args.grid, lanes), lod=args.lod,
            encoding="blocks", block_threshold_bytes=0,
        )
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        peak_mb = tracemalloc.get_traced_memory()[1] / 1_000_000
        tracemalloc.stop()
        encoded = json.dumps(payload, separators=(",", ":"))
        fills = payload["map"]["fills"]
        results.append({
            "grid": args.grid, "lanes": lanes, "lod": args.lod,
            "build_ms": round(elapsed_ms, 1), "peak_mb": round(peak_mb, 1),
            "wire_mb": round(len(encoded) / 1_000_000, 2),
            "blocks": len(payload["map"]["blocks"]),
            "shared_nodes_digest": len({fill["nodes"]["__block__"] for fill in fills}) == 1,
            "shared_triangles_digest": len({fill["triangles"]["__block__"] for fill in fills}) == 1,
        })
    print(json.dumps(results))


if __name__ == "__main__":
    main()
