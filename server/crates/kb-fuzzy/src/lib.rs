//! Port of the parts of the Python `rapidfuzz` library the server uses.
//!
//! The scores must equal rapidfuzz's exactly (they decide result order and thresholds), so the code follows
//! rapidfuzz's pure-Python reference (`fuzz_py.py`, `distance/Indel_py.py`, `distance/LCSseq_py.py`,
//! `process_py.py`, `utils_py.py`) and works on Unicode code points (`Vec<char>`), like Python `str`.
//! Only `str` inputs without a `processor` are supported (no call site passes one).

pub mod fuzz;
pub mod process;
pub mod utils;
