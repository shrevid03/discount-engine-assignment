"""Generates the sample cart PDFs in sample-data/ (python3 scripts/make-sample-pdfs.py, needs reportlab)."""
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

COLS = [60, 200, 330, 460]
HEAD = ["Product", "Brand", "Platform", "Base Price"]

def make(path, order, rows):
    c = canvas.Canvas(path, pagesize=A4)
    y = 780
    c.setFont("Helvetica-Bold", 12)
    c.drawString(COLS[0], y, order)
    y -= 40
    c.setFont("Helvetica-Bold", 10)
    for x, h in zip(COLS, HEAD):
        c.drawString(x, y, h)
    y -= 8
    c.line(COLS[0], y, 540, y)
    y -= 18
    c.setFont("Helvetica", 10)
    for r in rows:
        for x, v in zip(COLS, r):
            if v:
                c.drawString(x, y, v)
        y -= 20
    c.save()

SAMPLE = [
    ("Cushion Cover", "Natura Casa", "Amazon India", "Rs.1,299"),
    ("Bed Sheet Set", "Natura Casa", "Flipkart", "Rs.849"),
    ("Wall Shelf", "LivSpace Pro", "Amazon India", "Rs.599"),
    ("Ceramic Vase", "LivSpace Pro", "Noon", "Rs.2,499"),
    ("Cutting Board", "Nordic Basics", "Amazon India", "Rs.449"),
    ("Desk Organiser", "Nordic Basics", "Flipkart", "Rs.899"),
]
make("sample-data/cart.pdf", "Order #OP-9921   |   Date: 15 Jan 2025", SAMPLE)

make("sample-data/cart-small.pdf", "Order #OP-9922   |   Date: 16 Jan 2025", [
    ("Cushion Cover", "Natura Casa", "Amazon India", "Rs.1,299"),
    ("Ceramic Vase", "LivSpace Pro", "Noon", "Rs.2,499"),
])

make("sample-data/cart-malformed.pdf", "Order #OP-9923   |   Date: 17 Jan 2025", [
    ("Cushion Cover", "Natura Casa", "Amazon India", "Rs.1,299"),
    ("Bed Sheet Set", "Natura Casa", "Flipkart", ""),           # missing price
    ("Wall Shelf", "LivSpace Pro", "Amazon India", "Rs.TBD"),   # price not a number
    ("Ceramic Vase", "", "Noon", "Rs.2,499"),                   # missing brand
    ("Desk Organiser", "Nordic Basics", "Flipkart", "Rs.899"),
])
print("ok")
