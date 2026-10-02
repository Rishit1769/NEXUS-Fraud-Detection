import sys
import unittest
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parents[1]))

from nexus_ml.features import (
    URL_LEXICAL_FEATURE_NAMES,
    message_features,
    message_feature_frame,
    url_feature_frame,
    url_lexical_frame,
)
from nexus_ml.llm_features import LLM_FEATURE_NAMES, llm_feature_values


class FeatureTests(unittest.TestCase):
    def test_llm_features_are_fixed_numeric_and_bounded(self):
        values = llm_feature_values({
            "proposedRiskLevel": "HIGH",
            "proposedScore": 87,
            "confidence": 0.91,
            "disagreement": True,
        })
        self.assertEqual(list(values), LLM_FEATURE_NAMES)
        self.assertEqual(values["llm_proposed_score"], 87.0)
        self.assertEqual(values["llm_risk_high"], 1.0)
        self.assertEqual(values["llm_confidence"], 0.91)
        self.assertEqual(values["llm_disagreement"], 1.0)

    def test_message_features_are_deterministic_and_detect_signals(self):
        text = "URGENT: share your OTP now and pay the fee at https://bit.ly/test"
        first = message_features(text)
        second = message_features(text)
        self.assertEqual(first, second)
        self.assertGreater(first["urgency_terms"], 0)
        self.assertGreater(first["credential_terms"], 0)
        self.assertEqual(first["url_count"], 1)

    def test_message_frame_has_stable_numeric_columns(self):
        frame = message_feature_frame(pd.Series(["hello", "send OTP"]))
        self.assertEqual(frame.shape, (2, 18))
        self.assertTrue(all(str(dtype) == "float64" for dtype in frame.dtypes))

    def test_direction_features_separate_request_from_receipt(self):
        ask = message_features("Bank manager here, share your OTP now to stop fraud")
        got = message_features("Your OTP for login is 482913. Do not share it with anyone.")
        self.assertGreater(ask["share_request_terms"], 0)
        self.assertEqual(ask["code_receipt_terms"], 0)
        self.assertGreater(got["code_receipt_terms"], 0)
        self.assertGreater(got["no_share_advice_terms"], 0)

    def test_url_lexical_frame_scores_raw_urls(self):
        frame = url_lexical_frame(pd.Series(["https://bit.ly/test", "http://192.168.1.1/login"]))
        self.assertEqual(list(frame.columns), URL_LEXICAL_FEATURE_NAMES)
        self.assertEqual(frame.shape[0], 2)
        self.assertEqual(frame["lex_uses_shortener"].iloc[0], 1.0)
        self.assertEqual(frame["lex_has_ip_host"].iloc[1], 1.0)
        self.assertTrue(all(str(dtype) == "float64" for dtype in frame.dtypes))

    def test_url_features_ignore_text_columns(self):
        source = pd.DataFrame({"URL": ["https://example.com"] * 10, "Domain": ["example.com"] * 10, "label": [1] * 10, "URLLength": [19] * 10, "Title": ["Example"] * 10})
        features, names = url_feature_frame(source)
        self.assertIn("URLLength", names)
        self.assertNotIn("Title", names)
        self.assertEqual(features.shape[0], 10)


if __name__ == "__main__":
    unittest.main()
