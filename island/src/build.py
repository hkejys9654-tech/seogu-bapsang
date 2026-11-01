# 서구 아일랜드 빌드: src/head.html + src/template.html(+해온이 그림, 기본 뉴스) → index.html
import json, pathlib
src = pathlib.Path(__file__).resolve().parent
root = src.parent
t = (src / "template.html").read_text(encoding="utf-8")
haeon = json.dumps(json.loads((src / "haeon.json").read_text(encoding="utf-8")), ensure_ascii=False)
news = json.dumps(json.loads((root / "news.json").read_text(encoding="utf-8")), ensure_ascii=False)
t = t.replace("__HAEON__", haeon).replace("__NEWS__", news).replace("</style>\n", "</style>\n</head>\n<body>\n", 1)
(root / "index.html").write_text((src / "head.html").read_text(encoding="utf-8") + t + "\n</body>\n</html>\n", encoding="utf-8")
print("built", len(t))
