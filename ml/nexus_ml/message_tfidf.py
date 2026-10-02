"""TF-IDF + lexical message pipeline (NEXUS format).

Why this exists: term-count features cannot model word order, so
"share your OTP" (attacker asking) and "your OTP is 482913" (your own
notification) look identical. Character + word TF-IDF n-grams capture
phrases ("share your", "is 482913", "do not share") and generalize to
unseen scams far better than 18 hand counts.

Features = hstack([char_wb TF-IDF, word TF-IDF, lexical counts]).
The lexical block keeps the direction features (share_request /
code_receipt / no_share_advice) as dense companions to sparse n-grams.
"""
from __future__ import annotations

import pandas as pd
from scipy import sparse
from sklearn.feature_extraction.text import TfidfVectorizer

from .features import MESSAGE_FEATURE_NAMES, message_feature_frame
from .llm_features import LLM_FEATURE_NAMES, runtime_llm_frame, cached_llm_frame

CHAR_PARAMS = {
    "analyzer": "char_wb",
    "ngram_range": (3, 5),
    "min_df": 2,
    "max_features": 30_000,
    "sublinear_tf": True,
}
WORD_PARAMS = {
    "analyzer": "word",
    "ngram_range": (1, 2),
    "min_df": 2,
    "max_features": 20_000,
    "sublinear_tf": True,
}


def build_vectorizers() -> tuple[TfidfVectorizer, TfidfVectorizer]:
    return TfidfVectorizer(**CHAR_PARAMS), TfidfVectorizer(**WORD_PARAMS)


def fit_transform(
    char_vec: TfidfVectorizer, word_vec: TfidfVectorizer, texts: pd.Series,
    llm_features_path=None,
) -> sparse.csr_matrix:
    cleaned = texts.fillna("").astype(str)
    char_mat = char_vec.fit_transform(cleaned)
    word_mat = word_vec.fit_transform(cleaned)
    lex_mat = sparse.csr_matrix(message_feature_frame(cleaned).to_numpy())
    matrices = [char_mat, word_mat, lex_mat]
    if llm_features_path:
        matrices.append(sparse.csr_matrix(cached_llm_frame(cleaned, llm_features_path).to_numpy()))
    return sparse.hstack(matrices).tocsr()


def transform(
    char_vec: TfidfVectorizer,
    word_vec: TfidfVectorizer,
    texts: pd.Series,
    lex_columns: list[str] | None = None,
    llm_analysis: dict | None = None,
) -> sparse.csr_matrix:
    cleaned = texts.fillna("").astype(str)
    char_mat = char_vec.transform(cleaned)
    word_mat = word_vec.transform(cleaned)
    lex_frame = message_feature_frame(cleaned)
    if lex_columns is not None:
        lex_frame = lex_frame[lex_columns]
    lex_mat = sparse.csr_matrix(lex_frame.to_numpy())
    matrices = [char_mat, word_mat, lex_mat]
    if llm_analysis is not None:
        matrices.append(sparse.csr_matrix(runtime_llm_frame(llm_analysis, len(cleaned)).to_numpy()))
    return sparse.hstack(matrices).tocsr()


def feature_names(
    char_vec: TfidfVectorizer, word_vec: TfidfVectorizer
) -> list[str]:
    names = [f"char:{f}" for f in char_vec.get_feature_names_out().tolist()]
    names += [f"word:{f}" for f in word_vec.get_feature_names_out().tolist()]
    names += [f"lex:{c}" for c in MESSAGE_FEATURE_NAMES]
    return names
