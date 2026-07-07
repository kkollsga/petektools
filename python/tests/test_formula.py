import math

import pytest

import petektools as pt


def test_formula_info_distinguishes_params_properties_and_order():
    info = pt.formula_info([
        "Swirr = $SHF_c * pow(RQI, $SHF_d)",
        "RQI = $lambda * sqrt(PermXY_BC / PorE_BC)",
    ])

    assert info["outputs"] == ["Swirr", "RQI"]
    assert info["order"] == ["RQI", "Swirr"]
    assert info["params"] == ["SHF_c", "SHF_d", "lambda"]
    assert info["properties"] == ["PermXY_BC", "PorE_BC"]


def test_evaluate_formula_vectorized_block():
    out = pt.evaluate_formula(
        [
            "RQI = $lambda * sqrt(PermXY_BC / PorE_BC)",
            "Sw = if(HA_FWL == 0, 1, clip(RQI, 0.0, 1.0))",
        ],
        {
            "PermXY_BC": [100.0, 400.0, 900.0],
            "PorE_BC": [0.25, 0.25, 0.25],
            "HA_FWL": [0.0, 1.0, 1.0],
        },
        {"lambda": 0.0314},
    )

    assert out["RQI"] == pytest.approx([0.628, 1.256, 1.884])
    assert out["Sw"] == [1.0, 1.0, 1.0]


def test_formula_nan_propagation_and_errors():
    out = pt.evaluate_formula(
        ["Y = if(Flag == 1, X, 0)"],
        {"Flag": [1.0, 0.0], "X": [math.nan, 2.0]},
    )
    assert math.isnan(out["Y"][0])
    assert out["Y"][1] == 0.0

    with pytest.raises(ValueError, match="formula parameter"):
        pt.evaluate_formula(["A = $missing + X"], {"X": [1.0]})

    with pytest.raises(ValueError, match="shape mismatch"):
        pt.evaluate_formula(["A = X + Y"], {"X": [1.0, 2.0], "Y": [1.0]})

    with pytest.raises(ValueError, match="cyclic"):
        pt.formula_info(["A = B + 1", "B = A + 1"])
