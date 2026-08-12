# Annotation contract

## Required root fields

```json
{
  "pdf": {
    "filename": "book.pdf",
    "page_count": 2,
    "pages": [
      { "page": 1, "width": 1083, "height": 1508 }
    ]
  },
  "annotations": []
}
```

`pdf.pages` must describe every referenced annotation page. Page numbers are one-based.

## Audio annotation

```json
{
  "id": "audio-001",
  "type": "audio",
  "page": 5,
  "x": 606,
  "y": 197,
  "width": 64,
  "height": 64,
  "unit": "Unit 1",
  "audio_path": "audio/1-Unit 1.mp3"
}
```

Resolve `audio_path` relative to the annotation JSON directory unless `--audio-dir` is supplied. With `--audio-dir`, resolve by basename inside that directory.

## Transcript annotation

```json
{
  "id": "transcript-001",
  "type": "transcript",
  "page": 5,
  "x": 383,
  "y": 368,
  "width": 64,
  "height": 64,
  "question": "一、听录音，连线。",
  "text": "1. John's ear\n2. Chen Jie's mouth"
}
```

`question` and `text` must both be non-empty strings.

## Coordinate conversion

For every page independently:

```text
scale = targetCanvasWidth / sourcePageWidth
left = x * scale
top = y * scale
scaledWidth = width * scale
scaledHeight = height * scale
canvasHeight = sourcePageHeight * scale
```

If a supplied Lottie style defines exact visual width/height, use scaled `left/top` but preserve the style dimensions. Treat annotation width/height as the source hitbox in that mode.

## Target-page contract

The target Super Editor book must already be a PDF-based book. Match JSON page `N` to a slide whose `pdfpage.page_natural_code` equals `N`. Do not derive slideId arithmetically.
