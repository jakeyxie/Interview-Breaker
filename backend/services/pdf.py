from io import BytesIO

from pypdf import PdfReader


def extract_pdf_text(data: bytes, max_chars: int = 20000) -> str:
    reader = PdfReader(BytesIO(data))
    chunks: list[str] = []
    for page in reader.pages:
        text = page.extract_text() or ""
        if text.strip():
            chunks.append(text.strip())
        if sum(len(chunk) for chunk in chunks) >= max_chars:
            break
    return "\n\n".join(chunks)[:max_chars].strip()
