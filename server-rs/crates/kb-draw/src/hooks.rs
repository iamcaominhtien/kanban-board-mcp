//! Calls into areas that are above this crate (the Python code imports them late, inside a function). The upper
//! crate registers itself at startup; while a hook is not set the call is skipped.

use std::sync::OnceLock;

/// `canvas_png.Raster`: an RGB picture you can fill rectangles in, and write as a PNG.
pub trait Raster: Send {
    /// `Raster.rect(x, y, w, h, color)`: fill a rectangle (clipped to the picture).
    fn rect(&mut self, x: f64, y: f64, w: f64, h: f64, color: (u8, u8, u8));
    /// `Raster.frame(x, y, w, h, color, t)`: a rectangle's outline.
    fn frame(&mut self, x: f64, y: f64, w: f64, h: f64, color: (u8, u8, u8), t: u32);
    /// `Raster.line(x0, y0, x1, y1, color)`.
    fn line(&mut self, x0: f64, y0: f64, x1: f64, y1: f64, color: (u8, u8, u8));
    /// `Raster.png()`.
    fn png(&self) -> Vec<u8>;
}

/// `services/canvas_png.py` (the canvases area, which is not ported yet), as far as `diagram_model.wireframe_png`
/// calls it.
pub trait CanvasRaster: Send + Sync {
    /// `canvas_png.Raster(width, height)`: a white picture.
    fn new_raster(&self, width: u32, height: u32) -> Box<dyn Raster>;
}

static CANVAS_RASTER: OnceLock<Box<dyn CanvasRaster>> = OnceLock::new();

/// Register the canvas picture code (once, at startup; a second call is ignored).
pub fn set_canvas_raster(hook: Box<dyn CanvasRaster>) {
    let _ = CANVAS_RASTER.set(hook);
}

/// The canvas picture code, when its crate has registered itself.
pub fn canvas_raster() -> Option<&'static dyn CanvasRaster> {
    CANVAS_RASTER.get().map(|hook| hook.as_ref())
}
