"""Breeze's notebook kernel: runs notebook cells in one Python process, so variables carry from cell to cell.

Standard library only (no Jupyter install needed). Breeze writes one JSON request per line to stdin,
{"id": ..., "code": ...}, and reads JSON lines from stdout: "stream" (print output, as it happens), "display"
(a figure or display(x)), "result" (the value of the cell's last line), "error" (an exception), then "done" for each request. The program's own
print() goes through the stream messages, never straight to stdout, so the two can't mix.
"""
import ast
import base64
import builtins
import io
import json
import os
import sys
import traceback

PROTOCOL = sys.stdout
GLOBALS = {"__name__": "__main__", "__builtins__": builtins}
current = None  # the id of the request running now


def send(msg):
    PROTOCOL.write(json.dumps(msg) + "\n")
    PROTOCOL.flush()


class Stream(io.TextIOBase):
    def __init__(self, name):
        self.name = name

    def writable(self):
        return True

    def write(self, text):
        if text:
            send({"id": current, "type": "stream", "name": self.name, "text": text})
        return len(text)


def bundle(value):
    """A value as MIME data, the way Jupyter shows it: rich HTML or PNG when the object offers one."""
    data = {"text/plain": repr(value)}
    for mime, method in (("text/html", "_repr_html_"), ("image/png", "_repr_png_"), ("image/svg+xml", "_repr_svg_")):
        fn = getattr(value, method, None)
        if callable(fn):
            try:
                out = fn()
            except Exception:
                continue
            if out is None:
                continue
            if isinstance(out, bytes):
                out = base64.b64encode(out).decode("ascii")
            data[mime] = out
    return data


def display(*values):
    for v in values:
        send({"id": current, "type": "display", "data": bundle(v)})


def no_input(prompt=""):
    raise RuntimeError("input() can't ask for typing inside a notebook. Set the value in the code instead.")


def show_figures():
    """matplotlib figures the cell drew, as PNGs (then closed, as Jupyter's inline backend does)."""
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return
    for num in plt.get_fignums():
        buf = io.BytesIO()
        plt.figure(num).savefig(buf, format="png", bbox_inches="tight")
        send({"id": current, "type": "display", "data": {"image/png": base64.b64encode(buf.getvalue()).decode("ascii"), "text/plain": "<Figure>"}})
    plt.close("all")


def run(code):
    tree = ast.parse(code, "<cell>", "exec")
    last = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        last = ast.Expression(tree.body.pop().value)
    exec(compile(tree, "<cell>", "exec"), GLOBALS)
    if last is not None:
        value = eval(compile(last, "<cell>", "eval"), GLOBALS)
        if value is not None:
            GLOBALS["_"] = value
            send({"id": current, "type": "result", "data": bundle(value)})
    show_figures()


def main():
    global current
    sys.path[0] = os.getcwd()  # the notebook's folder, not this file's: its own modules import
    os.environ.setdefault("MPLBACKEND", "Agg")
    GLOBALS["display"] = display
    builtins.input = no_input
    sys.stdout = Stream("stdout")
    sys.stderr = Stream("stderr")
    count = 0
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except ValueError:
            continue
        current = req.get("id")
        count += 1
        try:
            run(req.get("code", ""))
        except KeyboardInterrupt:
            send({"id": current, "type": "error", "ename": "KeyboardInterrupt", "evalue": "", "traceback": ["Stopped"]})
        except BaseException as e:  # SystemExit too: the kernel stays up
            tb = traceback.format_exception(type(e), e, e.__traceback__)
            # Drop this file's own frames: only the cell's lines matter.
            lines = [t for t in tb if "breeze_kernel.py" not in t]
            send({"id": current, "type": "error", "ename": type(e).__name__, "evalue": str(e), "traceback": lines})
        sys.stdout.flush()
        send({"id": current, "type": "done", "count": count})


if __name__ == "__main__":
    main()
