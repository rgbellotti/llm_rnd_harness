//! The `view_img` tool: read a local image file, validate it, normalize
//! it to PNG (downscaling when a side is too long), and hand the bytes to
//! a vision-capable model. Only the image *metadata* is ever written to
//! the history transcript; the base64 pixels travel only to the model.
//!
//! Everything is in-process and atomic: read bytes -> hash -> sniff the
//! format -> decode -> downscale -> re-encode PNG -> hash again -> base64.
//! There is no external converter process, so there is no window between
//! the read and the conversion for the file to be swapped (TOCTOU).
//!
//! A drag-selected region can also be *sent alone*: [`PreparedImage::crop`]
//! cuts the selection out of the already-normalized, already-hashed image
//! the dialog showed — never a re-read of the file — and re-encodes and
//! hashes the crop the same way, so what the model receives is still
//! exactly what was hashed.

use ollama_rs::generation::tools::ToolInfo;
use serde::Serialize;
use sha2::{Digest, Sha256};

use base64::Engine as _;

pub(crate) const TOOL_NAME: &str = "view_img";

/// Byte cap on the source file, checked before any decode. Base64 inflates
/// by ~33% on the wire, so this keeps a single image from dominating the
/// request. Images above this are refused, not silently truncated.
pub(crate) const MAX_IMAGE_BYTES: usize = 24 * 1024 * 1024;

/// Longest side allowed. A larger image is downscaled to fit this bound
/// before it is sent. 1568 is the common "low detail" default across
/// providers and keeps token cost predictable for diagnostics screenshots.
pub(crate) const MAX_DIMENSION: u32 = 1568;

/// Smallest crop side, in pixels, that can be attached on its own. A
/// thinner selection is a slip of the mouse rather than a region worth
/// a separate image; the caller falls back to the full image.
pub(crate) const MIN_CROP_SIDE: u32 = 8;

/// The model-visible description used when the tool is registered.
const DESCRIPTION: &str = "Read a local image file and show it to the vision \
model. The file is validated (image/* only), normalized to PNG, and downscaled \
if a side exceeds 1568px. Returns the image metadata (path, dimensions, sha256) \
and makes the pixels visible to the model. The path is a filesystem path \
(absolute or relative to the workspace).";

pub(crate) fn tool_info() -> ToolInfo {
    serde_json::from_value(serde_json::json!({
        "type": "function",
        "function": {
            "name": TOOL_NAME,
            "description": DESCRIPTION,
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path to the image file to view."
                    }
                },
                "required": ["path"]
            }
        }
    }))
    .expect("view_img tool schema")
}

/// The model's arguments for one `view_img` call.
#[derive(Clone, Debug)]
pub(crate) struct ViewImgRequest {
    pub(crate) path: String,
}

impl ViewImgRequest {
    pub(crate) fn parse(args: &serde_json::Value) -> Result<Self, String> {
        let path = args
            .get("path")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .ok_or_else(|| "view_img requires a non-empty 'path'".to_string())?;
        if path.contains('\0') {
            return Err("view_img path cannot contain a null byte.".to_string());
        }
        Ok(ViewImgRequest {
            path: path.to_string(),
        })
    }
}

/// A normalized, model-ready image plus everything the approval dialog and
/// the transcript need to describe it.
#[derive(Clone, Debug)]
pub(crate) struct PreparedImage {
    /// The path as the model asked for it (for display and re-view).
    pub(crate) path: String,
    /// The source format's MIME type (e.g. "image/jpeg").
    pub(crate) source_mime: String,
    /// Always "image/png": what the model actually receives.
    pub(crate) mime: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) original_width: u32,
    pub(crate) original_height: u32,
    /// Source file size in bytes.
    pub(crate) byte_size: u64,
    /// Normalized PNG size in bytes.
    pub(crate) png_byte_size: u64,
    /// sha256 of the raw source bytes (read-time hash).
    pub(crate) sha256_source: String,
    /// sha256 of the normalized PNG the model receives.
    pub(crate) sha256_png: String,
    /// Base64 of the normalized PNG, no `data:` prefix.
    pub(crate) base64: String,
    pub(crate) downscaled: bool,
    /// The decoded, normalized image the dialog showed. Held only for the
    /// approval window, so a crop is cut from exactly the pixels that
    /// were hashed and displayed — never a re-read of the file, which
    /// could have changed since. Bounded by the 1568px cap (~10 MB RGBA
    /// worst case) and dropped as soon as the decision is made.
    pub(crate) image: image::DynamicImage,
}

/// The payload the approval dialog renders: a data URL for the `<img>`
/// plus the metadata to describe what the model will see.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct ImageDialog {
    pub(crate) path: String,
    pub(crate) mime: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) original_width: u32,
    pub(crate) original_height: u32,
    pub(crate) byte_size: u64,
    pub(crate) png_byte_size: u64,
    pub(crate) sha256: String,
    pub(crate) downscaled: bool,
    pub(crate) data_url: String,
}

/// The person's drag-select focus region, in normalized 0..1 coordinates.
/// `x`,`y` is the top-left corner, `w`,`h` the size, each in [0,1].
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
pub(crate) struct ImageRegion {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) w: f64,
    pub(crate) h: f64,
}

impl ImageRegion {
    /// Clamp to the unit square and require a non-trivial area. Returns
    /// `None` when the region is empty or degenerate (nothing to point at).
    pub(crate) fn normalized(self) -> Option<ImageRegion> {
        let x = self.x.clamp(0.0, 1.0);
        let y = self.y.clamp(0.0, 1.0);
        let w = (self.w.max(0.0)).min(1.0 - x);
        let h = (self.h.max(0.0)).min(1.0 - y);
        if w <= 0.0 || h <= 0.0 {
            return None;
        }
        Some(ImageRegion { x, y, w, h })
    }

    /// The sentence the model reads, so it knows which part of the image
    /// the person singled out.
    pub(crate) fn describe(&self) -> String {
        format!(
            "focus region: x={:.4} y={:.4} w={:.4} h={:.4} (normalized 0..1, \
             top-left origin; the person highlighted this part of the image)",
            self.x, self.y, self.w, self.h
        )
    }
}

/// The crop of a [`PreparedImage`]: the pixels inside one drag-selected
/// region, re-encoded and hashed in-process. Built only by
/// [`PreparedImage::crop`], from the already-normalized image that was
/// hashed and shown.
#[derive(Clone, Debug)]
pub(crate) struct CroppedImage {
    /// Always "image/png".
    pub(crate) mime: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
    /// The normalized image the crop was cut from, for the result text.
    pub(crate) source_width: u32,
    pub(crate) source_height: u32,
    /// Crop PNG size in bytes.
    pub(crate) png_byte_size: u64,
    /// sha256 of the crop PNG the model receives.
    pub(crate) sha256: String,
    /// Base64 of the crop PNG, no `data:` prefix.
    pub(crate) base64: String,
}

impl CroppedImage {
    /// The sentence the model reads so it knows the attached image is a
    /// selection, not the whole file. The region coordinates are in the
    /// `focus region` line just above; this only states the crop.
    pub(crate) fn describe(&self) -> String {
        format!(
            "attached image: only the selected region — {}x{} px crop of the {}x{} \
             normalized image, {} bytes PNG, sha256 of the crop: {}. The full image \
             was not sent; the focus region above locates the crop within it.",
            self.width, self.height, self.source_width, self.source_height,
            self.png_byte_size, self.sha256
        )
    }
}

impl PreparedImage {
    pub(crate) fn dialog(&self) -> ImageDialog {
        let data_url = format!("data:{};base64,{}", self.mime, self.base64);
        ImageDialog {
            path: self.path.clone(),
            mime: self.mime.clone(),
            width: self.width,
            height: self.height,
            original_width: self.original_width,
            original_height: self.original_height,
            byte_size: self.byte_size,
            png_byte_size: self.png_byte_size,
            sha256: self.sha256_source.clone(),
            downscaled: self.downscaled,
            data_url,
        }
    }

    /// The metadata text the model and the transcript store. The pixels are
    /// deliberately absent here — they travel only as the attached image.
    pub(crate) fn metadata_text(&self) -> String {
        let mut text = String::new();
        text.push_str(&format!("image: {}\n", self.path));
        text.push_str(&format!(
            "format: {} (normalized to {})\n",
            self.source_mime, self.mime
        ));
        if self.downscaled {
            text.push_str(&format!(
                "dimensions: {}x{} (downscaled from {}x{})\n",
                self.width, self.height, self.original_width, self.original_height
            ));
        } else {
            text.push_str(&format!("dimensions: {}x{}\n", self.width, self.height));
        }
        text.push_str(&format!("source bytes: {}\n", self.byte_size));
        text.push_str(&format!("png bytes: {}\n", self.png_byte_size));
        text.push_str(&format!("sha256 (source): {}\n", self.sha256_source));
        text.push_str(&format!("sha256 (png): {}\n", self.sha256_png));
        text
    }

    /// Cut one region out of the normalized image and re-encode it as a
    /// hashed PNG. The pixel rect comes from the normalized 0..1
    /// coordinates against the normalized dimensions, clamped
    /// defensively (callers pass regions that already went through
    /// [`ImageRegion::normalized`]). CPU-bound (crop + encode), so
    /// callers run it off the async runtime. `Err` means the region is
    /// too small to stand on its own or the encode failed; the caller
    /// keeps the full image and says why.
    pub(crate) fn crop(&self, region: &ImageRegion) -> Result<CroppedImage, String> {
        let left = ((region.x * f64::from(self.width)).floor() as u32).min(self.width.saturating_sub(1));
        let top = ((region.y * f64::from(self.height)).floor() as u32).min(self.height.saturating_sub(1));
        let right = (((region.x + region.w) * f64::from(self.width)).ceil() as u32)
            .clamp(left.saturating_add(1), self.width);
        let bottom = (((region.y + region.h) * f64::from(self.height)).ceil() as u32)
            .clamp(top.saturating_add(1), self.height);
        let crop_w = right - left;
        let crop_h = bottom - top;
        if crop_w < MIN_CROP_SIDE || crop_h < MIN_CROP_SIDE {
            return Err(format!(
                "the selected region is only {crop_w}x{crop_h} px; a crop must be \
                 at least {MIN_CROP_SIDE}x{MIN_CROP_SIDE} px to be sent on its own"
            ));
        }
        let cropped = self.image.crop_imm(left, top, crop_w, crop_h);
        let mut png = std::io::Cursor::new(Vec::new());
        cropped
            .write_to(&mut png, image::ImageFormat::Png)
            .map_err(|error| format!("the selected region could not be encoded as PNG: {error}"))?;
        let png = png.into_inner();
        let sha256 = hex(&Sha256::digest(&png));
        let base64 = base64::engine::general_purpose::STANDARD.encode(&png);
        Ok(CroppedImage {
            mime: "image/png".to_string(),
            width: crop_w,
            height: crop_h,
            source_width: self.width,
            source_height: self.height,
            png_byte_size: png.len() as u64,
            sha256,
            base64,
        })
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn source_mime(format: image::ImageFormat) -> &'static str {
    match format {
        image::ImageFormat::Png => "image/png",
        image::ImageFormat::Jpeg => "image/jpeg",
        image::ImageFormat::Gif => "image/gif",
        image::ImageFormat::WebP => "image/webp",
        image::ImageFormat::Bmp => "image/bmp",
        image::ImageFormat::Tiff => "image/tiff",
        // Not enabled as a codec, but listed so the match stays exhaustive
        // if a format is later added. It cannot occur here.
        _ => "image/*",
    }
}

fn scaled_dimensions(width: u32, height: u32, max: u32) -> (u32, u32) {
    if width <= max && height <= max {
        return (width, height);
    }
    let longest = width.max(height).max(1);
    let scale = max as f64 / longest as f64;
    let new_w = ((width as f64) * scale).round().max(1.0) as u32;
    let new_h = ((height as f64) * scale).round().max(1.0) as u32;
    (new_w, new_h)
}

/// Read, validate, normalize, and hash one image. CPU-bound (decode and
/// resize), so callers run it off the async runtime via `spawn_blocking`.
pub(crate) fn prepare(path: &str) -> Result<PreparedImage, String> {
    let bytes = std::fs::read(path)
        .map_err(|error| format!("cannot read image at {path}: {error}"))?;
    let byte_size = bytes.len() as u64;
    if byte_size == 0 {
        return Err(format!("image at {path} is empty"));
    }
    if byte_size > MAX_IMAGE_BYTES as u64 {
        return Err(format!(
            "image at {path} is {byte_size} bytes; the cap is {MAX_IMAGE_BYTES} bytes"
        ));
    }
    // sha256 of the raw bytes, taken at read time — before any conversion.
    let sha256_source = hex(&Sha256::digest(&bytes));

    // Enforce the image/* whitelist by sniffing the real format, not the
    // file extension. Unknown or non-image bytes are refused here.
    let format = image::guess_format(&bytes)
        .map_err(|_| format!("image at {path} is not a recognized image format (image/* only)"))?;
    let source_mime = source_mime(format).to_string();

    let decoded = image::load_from_memory(&bytes)
        .map_err(|_| format!("image at {path} could not be decoded (corrupt or unsupported)"))?;
    let (original_width, original_height) = (decoded.width(), decoded.height());
    let (width, height) = scaled_dimensions(original_width, original_height, MAX_DIMENSION);
    let downscaled = (width, height) != (original_width, original_height);
    let normalized = if downscaled {
        decoded.resize(width, height, image::imageops::FilterType::Lanczos3)
    } else {
        decoded
    };

    let mut png = std::io::Cursor::new(Vec::new());
    normalized
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|error| format!("image at {path} could not be encoded as PNG: {error}"))?;
    let png = png.into_inner();
    let png_byte_size = png.len() as u64;
    let sha256_png = hex(&Sha256::digest(&png));
    let base64 = base64::engine::general_purpose::STANDARD.encode(&png);

    Ok(PreparedImage {
        path: path.to_string(),
        source_mime,
        mime: "image/png".to_string(),
        width,
        height,
        original_width,
        original_height,
        byte_size,
        png_byte_size,
        sha256_source,
        sha256_png,
        base64,
        downscaled,
        image: normalized,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_bytes(img: image::RgbaImage) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut buf, image::ImageFormat::Png)
            .unwrap();
        buf.into_inner()
    }

    fn tiny_png() -> Vec<u8> {
        // A 2x2 RGBA PNG, valid and tiny.
        png_bytes(image::RgbaImage::from_fn(2, 2, |x, y| {
            image::Rgba([x as u8 * 100, y as u8 * 100, 0, 255])
        }))
    }

    fn tmp_file(bytes: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "view_img_test_{}_{}.png",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn parses_a_path_and_rejects_a_blank_one() {
        let ok = ViewImgRequest::parse(&serde_json::json!({"path": " /tmp/x.png "}));
        assert_eq!(ok.unwrap().path, "/tmp/x.png");
        assert!(ViewImgRequest::parse(&serde_json::json!({"path": ""})).is_err());
        assert!(ViewImgRequest::parse(&serde_json::json!({})).is_err());
        assert!(ViewImgRequest::parse(&serde_json::json!({"path": "a\0b"})).is_err());
    }

    #[test]
    fn prepares_a_valid_png_and_hashes_at_read_time() {
        let path = tmp_file(&tiny_png());
        let prepared = prepare(path.to_str().unwrap()).expect("prepare");
        assert_eq!(prepared.mime, "image/png");
        assert_eq!((prepared.width, prepared.height), (2, 2));
        assert!(!prepared.downscaled);
        assert_eq!(prepared.sha256_source.len(), 64);
        assert_eq!(prepared.sha256_png.len(), 64);
        // The metadata text carries no base64 and names the hashes.
        let text = prepared.metadata_text();
        assert!(text.contains("sha256 (source):"));
        assert!(text.contains("image/png"));
        assert!(!text.contains(prepared.base64.as_str()));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn refuses_non_image_bytes() {
        let path = tmp_file(b"this is not an image at all");
        assert!(prepare(path.to_str().unwrap()).is_err());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn downscales_an_oversized_image() {
        // 4000x4000 exceeds MAX_DIMENSION and must come back smaller.
        let img = image::RgbaImage::from_fn(4000, 4000, |_, _| image::Rgba([10, 20, 30, 255]));
        let mut buf = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut buf, image::ImageFormat::Png)
            .unwrap();
        let path = tmp_file(&buf.into_inner());
        let prepared = prepare(path.to_str().unwrap()).expect("prepare");
        assert!(prepared.downscaled);
        assert!(prepared.width <= MAX_DIMENSION && prepared.height <= MAX_DIMENSION);
        assert_eq!(prepared.original_width, 4000);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn the_dialog_carries_a_data_url_and_no_raw_base64_field() {
        let path = tmp_file(&tiny_png());
        let prepared = prepare(path.to_str().unwrap()).unwrap();
        let dialog = prepared.dialog();
        assert!(dialog.data_url.starts_with("data:image/png;base64,"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_region_is_normalized_and_degenerate_regions_are_dropped() {
        let ok = ImageRegion {
            x: -0.5,
            y: -0.5,
            w: 2.0,
            h: 2.0,
        }
        .normalized()
        .expect("clamped region");
        assert_eq!((ok.x, ok.y), (0.0, 0.0));
        assert_eq!((ok.w, ok.h), (1.0, 1.0));
        assert!(ImageRegion {
            x: 0.5,
            y: 0.5,
            w: 0.0,
            h: 0.3,
        }
        .normalized()
        .is_none());
    }

    #[test]
    fn a_crop_returns_the_selected_pixels_as_a_hashed_png() {
        // 16x16 with a distinct value per pixel; the crop is the
        // bottom-right 8x8 quadrant.
        let img = image::RgbaImage::from_fn(16, 16, |x, y| {
            image::Rgba([x as u8 * 16, y as u8 * 16, 7, 255])
        });
        let path = tmp_file(&png_bytes(img));
        let prepared = prepare(path.to_str().unwrap()).expect("prepare");
        let region = ImageRegion {
            x: 0.5,
            y: 0.5,
            w: 0.5,
            h: 0.5,
        }
        .normalized()
        .expect("region");
        let cropped = prepared.crop(&region).expect("crop");
        assert_eq!((cropped.width, cropped.height), (8, 8));
        assert_eq!((cropped.source_width, cropped.source_height), (16, 16));
        assert_eq!(cropped.mime, "image/png");
        assert_eq!(cropped.sha256.len(), 64);
        // Decode the attached bytes and check they are the selected
        // pixels, not a scaled or shifted copy.
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&cropped.base64)
            .expect("base64");
        let decoded = image::load_from_memory(&bytes).expect("crop decodes");
        assert_eq!((decoded.width(), decoded.height()), (8, 8));
        let pixels = decoded.to_rgba8();
        assert_eq!(pixels.get_pixel(0, 0), &image::Rgba([8 * 16, 8 * 16, 7, 255]));
        assert_eq!(pixels.get_pixel(7, 7), &image::Rgba([15 * 16, 15 * 16, 7, 255]));
        let describe = cropped.describe();
        assert!(describe.contains("only the selected region"), "{describe}");
        assert!(describe.contains("8x8"), "{describe}");
        assert!(describe.contains("16x16"), "{describe}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_too_small_crop_is_refused_and_a_full_image_crop_is_allowed() {
        let img = image::RgbaImage::from_fn(100, 100, |_, _| image::Rgba([9, 9, 9, 255]));
        let path = tmp_file(&png_bytes(img));
        let prepared = prepare(path.to_str().unwrap()).expect("prepare");
        // 0.02 of 100px is a 2px sliver: below the floor.
        let thin = ImageRegion {
            x: 0.0,
            y: 0.0,
            w: 0.02,
            h: 0.5,
        }
        .normalized()
        .expect("region");
        let refused = prepared.crop(&thin).expect_err("too small");
        assert!(refused.contains("at least"), "{refused}");
        // The whole image is a valid (if pointless) crop: same pixels,
        // allowed so the mode never refuses a working selection.
        let all = ImageRegion {
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
        }
        .normalized()
        .expect("region");
        let full = prepared.crop(&all).expect("full-image crop");
        assert_eq!((full.width, full.height), (100, 100));
        // A region that runs past the right edge (not pre-normalized) is
        // clamped defensively to the image edge, not out of bounds:
        // 0.9..1.1 of 100px is 90..100 -> a 10px column.
        let past = ImageRegion {
            x: 0.9,
            y: 0.0,
            w: 0.2,
            h: 1.0,
        };
        let clamped = prepared.crop(&past).expect("clamped crop");
        assert_eq!((clamped.width, clamped.height), (10, 100));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_crop_of_an_image_smaller_than_the_floor_is_refused() {
        // The 2x2 fixture: every possible crop is below the floor, so the
        // caller's fallback (attach the full image) is what the model gets.
        let path = tmp_file(&tiny_png());
        let prepared = prepare(path.to_str().unwrap()).expect("prepare");
        let region = ImageRegion {
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
        }
        .normalized()
        .expect("region");
        assert!(prepared.crop(&region).is_err());
        let _ = std::fs::remove_file(&path);
    }
}
