//! Reads a pasted link for "Embed from link" (design "Embeds", frames 59-66): the page's title, description, picture
//! and site name, whether the project lets the site be embedded, and for YouTube, Vimeo and Loom the player address.
//!
//! The server fetches the page itself, so the fetch must not reach the board's own network: only http and https,
//! every address a host resolves to must be public, the connection is pinned to the address that was checked (a
//! second DNS answer cannot swap it), redirects are followed by hand and checked again, 5 s timeouts, 1 MB read.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::LazyLock;
use std::time::Duration;

use kb_db::Session;
use regex::Regex;
use serde_json::{Map, Value, json};
use url::Url;

use crate::Result;
use crate::docs::{project, space};

/// The longest a fetch may take, per step.
const TIMEOUT: Duration = Duration::from_secs(5);
/// How much of a page is read.
const MAX_BYTES: usize = 1024 * 1024;
/// How many redirects are followed.
const MAX_REDIRECTS: usize = 5;

/// Why a link could not be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkFailure {
    /// Not http(s), or it leads to a private address: the server will not fetch it.
    Refused,
    /// The site did not answer, or not with a page.
    CouldNotRead,
}

impl LinkFailure {
    /// The `error` word of the answer.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Refused => "refused",
            Self::CouldNotRead => "could_not_read",
        }
    }
}

/// A video site whose links become a player.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoEmbed {
    /// `youtube`, `vimeo` or `loom`.
    pub provider: &'static str,
    /// The player address (YouTube's through youtube-nocookie.com).
    pub embed_url: String,
}

/// Whether an address may be fetched by the server: not loopback, private, link-local, shared (CGNAT), multicast,
/// unspecified, broadcast, documentation or benchmarking; IPv4 inside IPv6 (mapped, NAT64) is checked as IPv4.
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_v4(v4);
            }
            let s = v6.segments();
            // 64:ff9b::/96 (NAT64) carries an IPv4 address
            if s[0] == 0x64 && s[1] == 0xff9b && s[2..6].iter().all(|x| *x == 0) {
                let [a, b] = s[6].to_be_bytes();
                let [c, d] = s[7].to_be_bytes();
                return is_public_v4(Ipv4Addr::new(a, b, c, d));
            }
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // unique local
                || (s[0] & 0xffc0) == 0xfe80 // link-local
                || (s[0] & 0xffc0) == 0xfec0 // site-local (deprecated)
                || (s[0] == 0x2001 && s[1] == 0x0db8)) // documentation
        }
    }
}

fn is_public_v4(v4: Ipv4Addr) -> bool {
    let [a, b, c, _] = v4.octets();
    !(v4.is_private()
        || v4.is_loopback()
        || v4.is_link_local()
        || v4.is_unspecified()
        || v4.is_broadcast()
        || v4.is_multicast()
        || v4.is_documentation()
        || a == 0
        || (a == 100 && (64..128).contains(&b)) // shared address space (CGNAT)
        || (a == 192 && b == 0 && c == 0) // IETF protocol assignments
        || (a == 198 && (b == 18 || b == 19)) // benchmarking
        || a >= 240)
}

/// The host of a link without `www.`, lower case.
fn bare_host(url: &Url) -> String {
    let host = url.host_str().unwrap_or("").trim_end_matches('.').to_ascii_lowercase();
    host.strip_prefix("www.").map(str::to_string).unwrap_or(host)
}

/// Whether the host is one of the sites (`youtube.com` matches `m.youtube.com`, not `notyoutube.com`).
pub fn on_site_list(url: &Url, sites: &[String]) -> bool {
    let host = bare_host(url);
    sites.iter().any(|site| {
        let site = site.trim().trim_start_matches("www.").trim_end_matches('/').to_ascii_lowercase();
        // a list entry can carry a path (`google.com/maps`): its host part decides
        let site_host = site.split('/').next().unwrap_or("");
        !site_host.is_empty() && (host == site_host || host.ends_with(&format!(".{site_host}")))
    })
}

/// The player of a YouTube, Vimeo or Loom link, `None` for other links.
pub fn video_embed(url: &Url) -> Option<VideoEmbed> {
    let host = bare_host(url);
    let segments: Vec<&str> = url.path_segments().map(|s| s.filter(|p| !p.is_empty()).collect()).unwrap_or_default();
    let id_ok = |id: &str| {
        !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    };
    match host.as_str() {
        "youtube.com" | "m.youtube.com" | "music.youtube.com" | "youtube-nocookie.com" => {
            let id = match segments.as_slice() {
                ["watch", ..] => url.query_pairs().find(|(k, _)| k == "v").map(|(_, v)| v.into_owned()),
                ["shorts" | "embed" | "live" | "v", id, ..] => Some((*id).to_string()),
                _ => None,
            }?;
            id_ok(&id).then(|| VideoEmbed {
                provider: "youtube",
                embed_url: format!("https://www.youtube-nocookie.com/embed/{id}"),
            })
        }
        "youtu.be" => {
            let id = segments.first()?;
            id_ok(id).then(|| VideoEmbed {
                provider: "youtube",
                embed_url: format!("https://www.youtube-nocookie.com/embed/{id}"),
            })
        }
        "vimeo.com" | "player.vimeo.com" => {
            let id = segments.iter().find(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))?;
            Some(VideoEmbed { provider: "vimeo", embed_url: format!("https://player.vimeo.com/video/{id}") })
        }
        "loom.com" => match segments.as_slice() {
            ["share" | "embed", id, ..] if id_ok(id) => {
                Some(VideoEmbed { provider: "loom", embed_url: format!("https://www.loom.com/embed/{id}") })
            }
            _ => None,
        },
        _ => None,
    }
}

/// The address a link is fetched from, checked: http(s), a host, and every address it resolves to public.
///
/// # Errors
/// `Refused` for another scheme or a private address, `CouldNotRead` when the name does not resolve.
pub async fn checked_address(url: &Url) -> std::result::Result<SocketAddr, LinkFailure> {
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() {
        return Err(LinkFailure::Refused);
    }
    let port = url.port_or_known_default().ok_or(LinkFailure::Refused)?;
    let addrs: Vec<SocketAddr> = match url.host() {
        Some(url::Host::Ipv4(ip)) => vec![SocketAddr::new(IpAddr::V4(ip), port)],
        Some(url::Host::Ipv6(ip)) => vec![SocketAddr::new(IpAddr::V6(ip), port)],
        Some(url::Host::Domain(name)) => {
            let lowered = name.trim_end_matches('.').to_ascii_lowercase();
            if lowered == "localhost" || lowered.ends_with(".localhost") || lowered.ends_with(".internal") {
                return Err(LinkFailure::Refused);
            }
            tokio::time::timeout(TIMEOUT, tokio::net::lookup_host((lowered.as_str(), port)))
                .await
                .map_err(|_| LinkFailure::CouldNotRead)?
                .map_err(|_| LinkFailure::CouldNotRead)?
                .collect()
        }
        None => return Err(LinkFailure::Refused),
    };
    if addrs.is_empty() {
        return Err(LinkFailure::CouldNotRead);
    }
    if addrs.iter().any(|a| !is_public_ip(a.ip())) {
        return Err(LinkFailure::Refused);
    }
    Ok(addrs[0])
}

/// Fetches a page, following redirects by hand; returns the final address and up to 1 MB of the body (empty when
/// the answer is not HTML).
async fn fetch(start: &Url) -> std::result::Result<(Url, String), LinkFailure> {
    let mut url = start.clone();
    for _ in 0..=MAX_REDIRECTS {
        let addr = checked_address(&url).await?;
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(TIMEOUT)
            .connect_timeout(TIMEOUT)
            .user_agent("Mozilla/5.0 (compatible; KanbanBoard link preview)");
        if let Some(url::Host::Domain(name)) = url.host() {
            builder = builder.resolve(name, addr);
        }
        let client = builder.build().map_err(|_| LinkFailure::CouldNotRead)?;
        let mut resp = client
            .get(url.as_str())
            .header("accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5")
            .send()
            .await
            .map_err(|_| LinkFailure::CouldNotRead)?;
        if resp.status().is_redirection() {
            let next = resp
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .and_then(|loc| url.join(loc).ok())
                .ok_or(LinkFailure::CouldNotRead)?;
            url = next;
            continue;
        }
        if !resp.status().is_success() {
            return Err(LinkFailure::CouldNotRead);
        }
        let is_html = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_none_or(|t| t.to_ascii_lowercase().contains("html"));
        if !is_html {
            return Ok((url, String::new()));
        }
        let mut body: Vec<u8> = Vec::new();
        let read = async {
            while let Some(chunk) = resp.chunk().await.map_err(|_| LinkFailure::CouldNotRead)? {
                let room = MAX_BYTES - body.len();
                body.extend_from_slice(&chunk[..chunk.len().min(room)]);
                if body.len() >= MAX_BYTES {
                    break;
                }
            }
            Ok::<(), LinkFailure>(())
        };
        tokio::time::timeout(TIMEOUT, read).await.map_err(|_| LinkFailure::CouldNotRead)??;
        return Ok((url, String::from_utf8_lossy(&body).into_owned()));
    }
    Err(LinkFailure::CouldNotRead)
}

/// What the head of a page says about it.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PageMeta {
    /// `og:title`, else `<title>`.
    pub title: Option<String>,
    /// `og:description`, else `description`.
    pub description: Option<String>,
    /// `og:image` (made absolute; only http(s)).
    pub image: Option<String>,
    /// `og:site_name`.
    pub site: Option<String>,
}

static TITLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<title[^>]*>(.*?)</title>").expect("the title pattern is valid"));
static META: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<meta\b[^>]*>").expect("the meta pattern is valid"));
static ATTR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)([a-z_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))"#).expect("the attribute pattern is valid")
});

/// Decodes the common character references of a head (`&amp;`, `&#39;`, `&#x2019;`…).
fn unescape(text: &str) -> String {
    static REF: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,6});").expect("valid"));
    REF.replace_all(text, |c: &regex::Captures<'_>| {
        let name = &c[1];
        let ch = if let Some(hex) = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")) {
            u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
        } else if let Some(dec) = name.strip_prefix('#') {
            dec.parse::<u32>().ok().and_then(char::from_u32)
        } else {
            match name {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                _ => None,
            }
        };
        ch.map_or_else(|| c[0].to_string(), |ch| ch.to_string())
    })
    .into_owned()
}

/// Spaces folded, cut to `max` characters; `None` when empty.
fn tidy(text: &str, max: usize) -> Option<String> {
    let text = unescape(text).split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() { None } else { Some(text.chars().take(max).collect()) }
}

/// Reads the title, description, picture and site name of a page's HTML; `base` makes the picture absolute.
pub fn parse_meta(html: &str, base: &Url) -> PageMeta {
    let mut tags: Map<String, Value> = Map::new();
    for tag in META.find_iter(html) {
        let mut key = None;
        let mut content = None;
        for a in ATTR.captures_iter(tag.as_str()) {
            let name = a[1].to_ascii_lowercase();
            let value = a.get(2).or(a.get(3)).or(a.get(4)).map_or("", |m| m.as_str());
            match name.as_str() {
                "property" | "name" | "itemprop" => key = Some(value.to_ascii_lowercase()),
                "content" => content = Some(value.to_string()),
                _ => {}
            }
        }
        if let (Some(k), Some(v)) = (key, content) {
            tags.entry(k).or_insert(Value::String(v));
        }
    }
    let get = |k: &str| tags.get(k).and_then(Value::as_str);
    let title = get("og:title")
        .or_else(|| get("twitter:title"))
        .and_then(|t| tidy(t, 300))
        .or_else(|| TITLE.captures(html).and_then(|c| tidy(&c[1], 300)));
    let description = get("og:description")
        .or_else(|| get("twitter:description"))
        .or_else(|| get("description"))
        .and_then(|t| tidy(t, 500));
    let image = get("og:image")
        .or_else(|| get("og:image:url"))
        .or_else(|| get("twitter:image"))
        .and_then(|i| base.join(unescape(i.trim()).as_str()).ok())
        .filter(|u| matches!(u.scheme(), "http" | "https"))
        .map(String::from);
    let site = get("og:site_name").and_then(|s| tidy(s, 100));
    PageMeta { title, description, image, site }
}

/// The site list of the project's Docs settings, or the defaults without a project.
async fn embed_sites(session: &Session, project_id: Option<&str>) -> Result<Vec<String>> {
    let settings = match project_id.filter(|p| !p.is_empty()) {
        Some(pid) => space::read(&project(session, pid, false).await?),
        None => space::defaults(),
    };
    Ok(settings
        .get("embedSites")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default())
}

/// Answers `GET /docs/link-preview`: `{url, title, description, image, site, embeddable, kind, provider,
/// embed_url}`, or `{url, error}` when the link cannot be read (`kind`, `embeddable`, `provider` and `embed_url`
/// are still there for a known video site).
///
/// # Errors
/// The project errors when `project_id` is given (404, 403).
pub async fn link_preview(session: &Session, raw_url: &str, project_id: Option<&str>) -> Result<Value> {
    let sites = embed_sites(session, project_id).await?;
    let raw = raw_url.trim();
    let Ok(url) = Url::parse(raw) else {
        return Ok(json!({"url": raw, "error": LinkFailure::Refused.as_str()}));
    };
    let video = video_embed(&url);
    let embeddable = on_site_list(&url, &sites);
    let mut out = Map::new();
    out.insert("url".into(), json!(url.as_str()));
    match fetch(&url).await {
        Ok((final_url, html)) => {
            let meta = parse_meta(&html, &final_url);
            out.insert("title".into(), json!(meta.title));
            out.insert("description".into(), json!(meta.description));
            out.insert("image".into(), json!(meta.image));
            out.insert("site".into(), json!(meta.site.unwrap_or_else(|| bare_host(&url))));
        }
        Err(failure) => {
            out.insert("error".into(), json!(failure.as_str()));
        }
    }
    out.insert("embeddable".into(), json!(embeddable));
    match video {
        Some(v) if embeddable => {
            out.insert("kind".into(), json!("video"));
            out.insert("provider".into(), json!(v.provider));
            out.insert("embed_url".into(), json!(v.embed_url));
        }
        _ => {
            out.insert("kind".into(), json!("link"));
            out.insert("embed_url".into(), Value::Null);
        }
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn private_and_special_addresses_are_not_public() {
        for ip in [
            "127.0.0.1",
            "127.8.9.10",
            "10.0.0.1",
            "10.255.255.255",
            "172.16.0.1",
            "172.31.255.1",
            "192.168.1.1",
            "169.254.169.254",
            "0.0.0.0",
            "100.64.0.1",
            "255.255.255.255",
            "224.0.0.1",
            "::1",
            "::",
            "fe80::1",
            "fc00::1",
            "fd12:3456::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "64:ff9b::a9fe:a9fe",
            "ff02::1",
        ] {
            assert!(!is_public_ip(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"] {
            assert!(is_public_ip(ip.parse().unwrap()), "{ip}");
        }
    }

    #[tokio::test]
    async fn the_fetch_refuses_private_hosts_and_other_schemes() {
        for u in [
            "http://127.0.0.1/",
            "http://10.1.2.3:8080/admin",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::1]/",
            "http://localhost:3000/",
            "http://app.localhost/",
            "file:///etc/passwd",
            "ftp://example.com/",
            "http://user:pw@example.com/",
            "http://0x7f000001/",
            "http://2130706433/",
        ] {
            assert_eq!(checked_address(&url(u)).await, Err(LinkFailure::Refused), "{u}");
        }
    }

    #[test]
    fn video_sites_give_a_player() {
        let yt = video_embed(&url("https://www.youtube.com/watch?v=k3Rn8e_x-1&t=10")).unwrap();
        assert_eq!(yt.provider, "youtube");
        assert_eq!(yt.embed_url, "https://www.youtube-nocookie.com/embed/k3Rn8e_x-1");
        assert_eq!(
            video_embed(&url("https://youtu.be/abc123")).unwrap().embed_url,
            "https://www.youtube-nocookie.com/embed/abc123"
        );
        assert_eq!(video_embed(&url("https://youtube.com/shorts/abc")).unwrap().provider, "youtube");
        assert_eq!(
            video_embed(&url("https://vimeo.com/76979871")).unwrap().embed_url,
            "https://player.vimeo.com/video/76979871"
        );
        assert_eq!(
            video_embed(&url("https://www.loom.com/share/0281766fa2d04bb788eaf19e65135184")).unwrap().embed_url,
            "https://www.loom.com/embed/0281766fa2d04bb788eaf19e65135184"
        );
        assert!(video_embed(&url("https://www.youtube.com/watch?v=bad\"id")).is_none());
        assert!(video_embed(&url("https://example.com/watch?v=abc")).is_none());
        assert!(video_embed(&url("https://notyoutube.com/watch?v=abc")).is_none());
    }

    #[test]
    fn the_site_list_matches_hosts_and_subdomains_only() {
        let sites: Vec<String> =
            ["youtube.com", "google.com/maps", "gist.github.com"].iter().map(|s| s.to_string()).collect();
        assert!(on_site_list(&url("https://www.youtube.com/watch?v=1"), &sites));
        assert!(on_site_list(&url("https://m.youtube.com/watch?v=1"), &sites));
        assert!(!on_site_list(&url("https://notyoutube.com/"), &sites));
        assert!(on_site_list(&url("https://google.com/maps/place/x"), &sites));
        assert!(!on_site_list(&url("https://github.com/x"), &sites));
        assert!(on_site_list(&url("https://gist.github.com/x/1"), &sites));
    }

    #[test]
    fn the_head_of_a_page_is_read() {
        let html = r#"<html><head><title>  Plain &amp; title </title>
            <meta property="og:title" content="How we plan a quarter">
            <meta content='A short guide to roadmaps &#8212; with a template.' name="description">
            <meta property="og:image" content="/img/cover.png">
            <meta property="og:site_name" content="Example">
            </head><body>x</body></html>"#;
        let meta = parse_meta(html, &url("https://example.com/blog/post"));
        assert_eq!(meta.title.as_deref(), Some("How we plan a quarter"));
        assert_eq!(meta.description.as_deref(), Some("A short guide to roadmaps \u{2014} with a template."));
        assert_eq!(meta.image.as_deref(), Some("https://example.com/img/cover.png"));
        assert_eq!(meta.site.as_deref(), Some("Example"));

        let plain = parse_meta(
            "<title>Plain &amp; title</title><meta property=og:image content=javascript:alert(1)>",
            &url("https://e.com/"),
        );
        assert_eq!(plain.title.as_deref(), Some("Plain & title"));
        assert_eq!(plain.image, None);
    }
}
