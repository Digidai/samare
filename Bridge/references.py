"""Resolve only references explicitly present in an already linked Markdown note."""
import contextlib
import os
import re
import stat
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit

MARKDOWN = {".md", ".markdown", ".mdown", ".mkd", ".mkdn", ".mdtext"}
IMAGE_TYPES = {
    ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg",
    ".gif":"image/gif", ".webp":"image/webp", ".avif":"image/avif",
    ".bmp":"image/bmp", ".tif":"image/tiff", ".tiff":"image/tiff",
}
_DEST = r'(<[^<>\n]+>|(?:\\.|[^()\s]|\([^()\n]*\))+)'
_INLINE = re.compile(r'(!?)\[(?:\\.|[^\]\\\n])*\]\(\s*' + _DEST + r'(?:\s+(?:"[^"\n]*"|\'[^\'\n]*\'|\([^()\n]*\)))?\s*\)')
_WIKI = re.compile(r'(!?)\[\[([^\[\]\n|]+)(?:\|[^\]\n]*)?\]\]')
_DEFINITION = re.compile(r'^ {0,3}\[([^]\n]+)\]:[ \t]*' + _DEST, re.M)
_REFERENCE = re.compile(r'(!?)\[([^]\n]*)\]\[([^]\n]*)\]')


def visible_markdown(source):
    result, fence = [], None
    for line in source.splitlines(keepends=True):
        f = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)",line)
        if fence:
            if f and f[1][0] == fence[0] and len(f[1]) >= len(fence) and not f[2].strip():
                fence = None
        elif f:
            fence = f[1]
        elif not line.startswith(("    ","\t")):
            result.append(line)
    return re.sub(r'(?<!`)(`+)(?!`)[\s\S]*?\1(?!`)', '', ''.join(result))


def references(source):
    source = visible_markdown(source)
    result = {True:set(), False:set()}
    definitions = {m[1].strip().casefold():m[2] for m in _DEFINITION.finditer(source)}
    for pattern in (_INLINE, _WIKI):
        for match in pattern.finditer(source):
            result[bool(match[1])].add(canonical_ref(match[2]))
    for m in _REFERENCE.finditer(source):
        destination = definitions.get((m[3] or m[2]).strip().casefold())
        if destination:
            result[bool(m[1])].add(canonical_ref(destination))
    return result


def canonical_ref(value):
    if value.startswith("<") and value.endswith(">"):
        value = value[1:-1]
    return unquote(re.sub(r'\\([()\[\] ])', r'\1', value)).strip()


def relative_name(ref):
    if any(ord(c) < 32 for c in ref) or "\\" in ref:
        raise FileNotFoundError
    parts = urlsplit(ref)
    if parts.scheme or parts.netloc or parts.query or parts.path.startswith("/"):
        raise FileNotFoundError
    return parts.path, parts.fragment


def inside(path, root):
    # Resolve the lexical path before any filesystem traversal. Open each component
    # with NOFOLLOW below to keep renamed directories and links from widening scope.
    canonical = Path(os.path.normpath(str(path)))
    try:
        return canonical.relative_to(root)
    except ValueError:
        raise FileNotFoundError from None


@contextlib.contextmanager
def open_member(root, path):
    parts = inside(path, root).parts
    if not parts or any(part in ("", ".", "..") for part in parts):
        raise FileNotFoundError
    flags = os.O_RDONLY | os.O_NOFOLLOW
    directory = os.open(str(root), flags | os.O_DIRECTORY)
    try:
        for part in parts[:-1]:
            child = os.open(part, flags | os.O_DIRECTORY, dir_fd=directory)
            os.close(directory)
            directory = child
        fd = os.open(parts[-1], flags | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(fd, "rb") as stream:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise FileNotFoundError
            yield stream
    finally:
        os.close(directory)


def raster(path, doc, root):
    local, _ = relative_name(path)
    suffix = PurePosixPath(local).suffix.lower()
    if suffix not in IMAGE_TYPES:
        raise FileNotFoundError
    try:
        with open_member(root, doc.parent / local) as source:
            size = os.fstat(source.fileno()).st_size
            if size < 4 or size > 48 * 1024 * 1024:
                raise FileNotFoundError
            content = source.read(size + 1)
    except OSError:
        raise FileNotFoundError from None
    mime = IMAGE_TYPES[suffix]
    valid = {
        "image/png":content.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg":content.startswith(b"\xff\xd8\xff"),
        "image/gif":content.startswith((b"GIF87a",b"GIF89a")),
        "image/webp":content.startswith(b"RIFF") and content[8:12]==b"WEBP",
        "image/avif":content[4:8]==b"ftyp" and content[8:12] in (b"avif",b"avis"),
        "image/bmp":content.startswith(b"BM"),
        "image/tiff":content.startswith((b"II*\x00",b"MM\x00*")),
    }[mime]
    if not valid:
        raise FileNotFoundError
    return mime, content
