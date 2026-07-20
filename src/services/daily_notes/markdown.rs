use comrak::html::{ChildRendering, dangerous_url, escape, render_sourcepos};
use comrak::nodes::{Ast, Node, NodeValue};
use comrak::{Arena, Options, create_formatter, parse_document};
use regex::RegexBuilder;
use serde::Serialize;
use std::collections::HashMap;
use std::fmt::Write;

#[derive(Debug, Serialize)]
pub struct RenderedMarkdown {
    pub html: String,
    pub match_count: usize,
}

#[derive(Default)]
struct RenderState {
    image_widths: HashMap<usize, u8>,
}

create_formatter!(DailyNoteFormatter<RenderState>, {
    NodeValue::Image(ref link) => |context, node, entering| {
        if entering {
            context.write_str("<img")?;
            render_sourcepos(context, node)?;
            context.write_str(" src=\"")?;
            if !dangerous_url(&link.url) {
                context.escape_href(&link.url)?;
            }
            context.write_str("\" alt=\"")?;
            return Ok(ChildRendering::Plain);
        }
        if !link.title.is_empty() {
            context.write_str("\" title=\"")?;
            context.escape(&link.title)?;
        }
        context.write_str("\"")?;
        if let Some(width) = context.user.image_widths.get(&node_id(node)).copied() {
            write!(context, " style=\"width: {width}%\"")?;
        }
        context.write_str(" />")?;
    },
    NodeValue::Link(ref link) => |context, node, entering| {
        if entering {
            context.write_str("<a")?;
            render_sourcepos(context, node)?;
            context.write_str(" href=\"")?;
            if !dangerous_url(&link.url) {
                context.escape_href(&link.url)?;
            }
            if !link.title.is_empty() {
                context.write_str("\" title=\"")?;
                context.escape(&link.title)?;
            }
            context.write_str("\"")?;
            if is_external_url(&link.url) && !dangerous_url(&link.url) {
                context.write_str(" target=\"_blank\" rel=\"noopener noreferrer\"")?;
            }
            context.write_str(">")?;
        } else {
            context.write_str("</a>")?;
        }
    },
});

pub fn render(markdown: &str, query: Option<&str>) -> anyhow::Result<RenderedMarkdown> {
    let arena = Arena::new();
    let options = options();
    let root = parse_document(&arena, markdown, &options);
    let image_widths = extract_image_widths(root);
    let match_count = highlight_matches(&arena, root, query)?;
    let mut html = String::new();
    DailyNoteFormatter::format_document(root, &options, &mut html, RenderState { image_widths })
        .map_err(|_| anyhow::anyhow!("failed to format Markdown"))?;
    Ok(RenderedMarkdown { html, match_count })
}

pub fn highlight_plain(value: &str, query: &str) -> Option<String> {
    let expression = match_expression(query).ok()?;
    let matches = expression.find_iter(value).collect::<Vec<_>>();
    if matches.is_empty() {
        return None;
    }
    let mut html = String::new();
    let mut start = 0;
    for found in matches {
        escape(&mut html, &value[start..found.start()]).ok()?;
        html.push_str("<mark>");
        escape(&mut html, &value[found.start()..found.end()]).ok()?;
        html.push_str("</mark>");
        start = found.end();
    }
    escape(&mut html, &value[start..]).ok()?;
    Some(html)
}

pub fn highlight_excerpt(markdown: &str, query: &str) -> Option<String> {
    let arena = Arena::new();
    let root = parse_document(&arena, markdown, &options());
    let text = root.collect_text();
    let found = match_expression(query).ok()?.find(&text)?;
    let start = text[..found.start()]
        .char_indices()
        .rev()
        .nth(80)
        .map_or(0, |(index, _)| index);
    let end = text[found.end()..]
        .char_indices()
        .nth(80)
        .map_or(text.len(), |(index, _)| found.end() + index);
    let mut html = highlight_plain(&text[start..end], query)?;
    if start > 0 {
        html.insert(0, '…');
    }
    if end < text.len() {
        html.push('…');
    }
    Some(html)
}

fn options() -> Options<'static> {
    let mut options = Options::default();
    options.extension.strikethrough = true;
    options.extension.tagfilter = true;
    options.extension.table = true;
    options.extension.autolink = true;
    options.extension.tasklist = true;
    options.render.r#unsafe = false;
    options.render.sourcepos = true;
    options
}

fn extract_image_widths(root: Node<'_>) -> HashMap<usize, u8> {
    let images = root
        .descendants()
        .filter(|node| matches!(node.data.borrow().value, NodeValue::Image(_)))
        .collect::<Vec<_>>();
    let mut widths = HashMap::new();
    for image in images {
        let Some(sibling) = image.next_sibling() else {
            continue;
        };
        let literal = match &sibling.data.borrow().value {
            NodeValue::Text(literal) => literal.clone(),
            _ => continue,
        };
        let Some((width, consumed)) = width_prefix(&literal) else {
            continue;
        };
        widths.insert(node_id(image), width);
        let remainder = literal[consumed..].to_owned();
        if remainder.is_empty() {
            sibling.detach();
        } else {
            sibling.data.borrow_mut().value = NodeValue::Text(remainder.into());
        }
    }
    widths
}

fn width_prefix(value: &str) -> Option<(u8, usize)> {
    let suffix = value.strip_prefix("{width=")?;
    let end = suffix.find("%}")?;
    let width = suffix[..end].parse::<u8>().ok()?;
    (20..=100)
        .contains(&width)
        .then_some((width, "{width=".len() + end + 2))
}

fn highlight_matches<'a>(
    arena: &'a Arena<'a>,
    root: Node<'a>,
    query: Option<&str>,
) -> anyhow::Result<usize> {
    let Some(query) = query.map(str::trim).filter(|query| !query.is_empty()) else {
        return Ok(0);
    };
    let expression = match_expression(query)?;
    let text_nodes = root
        .descendants()
        .filter(|node| {
            matches!(node.data.borrow().value, NodeValue::Text(_))
                && !node
                    .ancestors()
                    .any(|ancestor| matches!(ancestor.data.borrow().value, NodeValue::Image(_)))
        })
        .collect::<Vec<_>>();
    let mut count = 0;
    for node in text_nodes {
        let literal = match &node.data.borrow().value {
            NodeValue::Text(literal) => literal.clone(),
            _ => continue,
        };
        let matches = expression.find_iter(&literal).collect::<Vec<_>>();
        if matches.is_empty() {
            continue;
        }
        let sourcepos = node.data.borrow().sourcepos;
        let mut start = 0;
        for found in matches {
            if found.start() > start {
                insert_text_before(arena, node, &literal[start..found.start()], sourcepos);
            }
            let highlight =
                arena.alloc(Ast::new_with_sourcepos(NodeValue::Highlight, sourcepos).into());
            highlight.append(
                arena.alloc(
                    Ast::new_with_sourcepos(
                        NodeValue::Text(literal[found.start()..found.end()].to_owned().into()),
                        sourcepos,
                    )
                    .into(),
                ),
            );
            node.insert_before(highlight);
            start = found.end();
            count += 1;
        }
        if start < literal.len() {
            insert_text_before(arena, node, &literal[start..], sourcepos);
        }
        node.detach();
    }
    Ok(count)
}

fn match_expression(query: &str) -> Result<regex::Regex, regex::Error> {
    RegexBuilder::new(&regex::escape(query))
        .case_insensitive(true)
        .build()
}

fn insert_text_before<'a>(
    arena: &'a Arena<'a>,
    sibling: Node<'a>,
    text: &str,
    sourcepos: comrak::nodes::Sourcepos,
) {
    sibling.insert_before(
        arena.alloc(
            Ast::new_with_sourcepos(NodeValue::Text(text.to_owned().into()), sourcepos).into(),
        ),
    );
}

fn node_id(node: Node<'_>) -> usize {
    std::ptr::from_ref(node) as usize
}

fn is_external_url(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_safe_gfm() {
        let rendered = render(
            "| A | B |\n|---|---|\n| 1 | 2 |\n\n- [x] Done\n\n~~old~~\n\n<script>alert(1)</script>\n\n[jump](javascript:alert(1))\n\n[site](https://example.com)",
            None,
        )
        .unwrap();
        assert!(rendered.html.contains("<table "));
        assert!(rendered.html.contains("type=\"checkbox\""));
        assert!(rendered.html.contains("<del "));
        assert!(rendered.html.contains(">old</del>"));
        assert!(!rendered.html.contains("<script>"));
        assert!(!rendered.html.contains("javascript:"));
        assert!(rendered.html.contains("rel=\"noopener noreferrer\""));
    }

    #[test]
    fn renders_only_controlled_image_widths() {
        let rendered = render(
            "![chart](/api/daily-notes/images/1){width=65%}\n\n![small](/x){width=10%}",
            None,
        )
        .unwrap();
        assert!(rendered.html.contains("style=\"width: 65%\""));
        assert!(
            rendered.html.contains("data-sourcepos=\"1:1-1:46\""),
            "{}",
            rendered.html
        );
        assert!(rendered.html.contains("{width=10%}"));
    }

    #[test]
    fn highlights_visible_text_case_insensitively() {
        let rendered = render(
            "# Breakout\n\nA breakout and **BREAKOUT**.\n\n`breakout`",
            Some("breakout"),
        )
        .unwrap();
        assert_eq!(rendered.match_count, 3);
        assert_eq!(rendered.html.matches("<mark ").count(), 3);
        assert!(rendered.html.contains(">breakout</code>"));
    }

    #[test]
    fn creates_safe_plain_highlights_and_body_excerpt() {
        assert_eq!(
            highlight_plain("A <breakout>", "BREAK"),
            Some("A &lt;<mark>break</mark>out&gt;".to_owned())
        );
        let excerpt =
            highlight_excerpt("# Heading\n\nA **breakout** inside the note.", "breakout").unwrap();
        assert!(excerpt.contains("<mark>breakout</mark>"));
        assert!(!excerpt.contains("**"));
    }
}
