"""LocalBit's quality check: 60 made-up questions, the same for every model, each graded by a script - no AI judge.
Four groups of 15: math (word problems, a number answer), instructions (a format a script can check), facts (one right answer),
code (what a short Python snippet prints - read, never run). grade(q, reply) -> True/False. Run by run_3090.py."""
import json
import re

Q = []
def _add(cat, prompt, kind, answer=None, **kw):
    Q.append(dict(id="%s%02d" % (cat[0], sum(1 for q in Q if q["cat"] == cat) + 1), cat=cat, prompt=prompt, kind=kind, answer=answer, **kw))

NUM = " Answer with just the number."
for p, a in (("A shop sells pens at $3 each. Mara buys 7 pens and pays with a $50 bill. How much change does she get, in dollars?", 29),
             ("A train travels 180 km in 2.5 hours. What is its average speed in km per hour?", 72),
             ("What is 15% of 240?", 36),
             ("A rectangle is 12 m long and 7 m wide. What is its area in square meters?", 84),
             ("Tomas has 3 boxes with 14 marbles in each. He gives away 9 marbles. How many does he have left?", 33),
             ("What is the sum of all whole numbers from 1 to 20?", 210),
             ("A recipe uses 3 eggs for 4 people. How many eggs are needed for 12 people?", 9),
             ("A jacket costs $80. It is discounted by 25%, then 10% tax is added to the discounted price. What is the final price in dollars?", 66),
             ("If x + 7 = 19, what is 3x?", 36),
             ("How many minutes are there from 9:45 to 11:20?", 95),
             ("A 500-liter tank already holds 140 liters and fills at 20 liters per minute. How many minutes until it is full?", 18),
             ("What is the average of 4, 8, 15, 16, 23 and 42?", 18),
             ("What is 2 to the power of 10?", 1024),
             ("A car uses 6 liters of fuel per 100 km. How many liters does it use for 350 km?", 21),
             ("Seven friends meet and every pair shakes hands once. How many handshakes are there?", 21)):
    _add("math", p + NUM, "num", a)

for p, kind, a in (("What is the capital city of Australia?", "text", ["canberra"]),
                   ("What is the chemical symbol for gold?", "text", ["au"]),
                   ("How many planets are in the Solar System?", "num", 8),
                   ("In what year did the Berlin Wall fall?", "num", 1989),
                   ("What is the largest ocean on Earth?", "text", ["pacific"]),
                   ("Who wrote the novel Pride and Prejudice?", "text", ["austen"]),
                   ("Which gas do plants take in from the air for photosynthesis?", "text", ["carbon dioxide", "co2"]),
                   ("What is the hardest natural substance?", "text", ["diamond"]),
                   ("How many bones are in the adult human body?", "num", 206),
                   ("What is the smallest prime number?", "num", 2),
                   ("What is the longest river in South America?", "text", ["amazon"]),
                   ("At what temperature in degrees Fahrenheit does water freeze?", "num", 32),
                   ("Which language has the most native speakers in the world?", "text", ["mandarin", "chinese"]),
                   ("Which planet is known as the Red Planet?", "text", ["mars"]),
                   ("Who painted the Mona Lisa?", "text", ["leonardo", "da vinci"])):
    _add("facts", p + " Answer in a few words.", kind, a)

CODE = "What does this Python code print? Answer with just the output.\n\n"
for code, kind, a in (('print(len("localbit"))', "num", 8),
                      ("print(sum(range(5)))", "num", 10),
                      ("x = [3, 1, 2]\nx.sort()\nprint(x[0])", "num", 1),
                      ('print("ab" * 3)', "exact", "ababab"),
                      ("print(7 // 2)", "num", 3),
                      ("print(7 % 3)", "num", 1),
                      ('d = {"a": 1, "b": 2}\nprint(d.get("c", 5))', "num", 5),
                      ("print([i * i for i in range(4)][-1])", "num", 9),
                      ('s = "hello"\nprint(s[::-1])', "exact", "olleh"),
                      ('print(int("12") + int("30"))', "num", 42),
                      ("a = 5\nb = a\na = a + 1\nprint(b)", "num", 5),
                      ("print(max([4, 9, 2], key=lambda n: -n))", "num", 2),
                      ('print("-".join("abc"))', "exact", "a-b-c"),
                      ('n = 0\nfor c in "banana":\n    n += c == "a"\nprint(n)', "num", 3),
                      ("print(len(set([1, 2, 2, 3, 3, 3])))", "num", 3)):
    _add("code", CODE + code, kind, a)

for p, chk in (("List exactly five fruits, separated by commas, and nothing else.", "five_commas"),
               ("Reply with only the word YES in capital letters.", "only_yes"),
               ("Write one sentence about the sea using only lowercase letters.", "lowercase"),
               ('Reply with a JSON object that has exactly the keys "name" and "age" (any values), and nothing else.', "json_keys"),
               ("Write exactly three lines, each starting with a dash (-).", "three_dashes"),
               ("Give a whole number between 10 and 20, and nothing else.", "num_10_20"),
               ("Write one sentence about trees that does not contain the letter e.", "no_e"),
               ("Reply in exactly five words.", "five_words"),
               ("Tell me one fact about the Moon, and end your reply with the word DONE.", "ends_done"),
               ("Repeat this exactly, and nothing else: The quick brown fox.", "repeat_fox"),
               ("Answer with only a single digit: how many sides does a triangle have?", "digit_3"),
               ("Write the word apple backwards, and nothing else.", "elppa"),
               ("List the numbers 1 to 5 in reverse order, separated by spaces, and nothing else.", "reverse_5"),
               ("Reply with two words, a color and an animal, separated by a space, in all capital letters.", "two_upper"),
               ("Write a title for a story about a lighthouse: no more than six words, every word capitalized, no punctuation.", "title")):
    _add("instructions", p, "check", chk)


def _clean(s):
    s = re.sub(r"<think>.*?</think>", "", s or "", flags=re.S)
    s = re.sub(r"```[a-zA-Z]*\n?|```", "", s)
    return s.strip()


def _nums(s):
    return [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", s.replace(",", ""))]


def _words(s):
    return re.findall(r"[A-Za-z0-9'’-]+", s)


SMALL = {"a", "an", "the", "of", "and", "in", "on", "at", "to", "for", "by", "or"}
CHECK = {
    "five_commas": lambda s: "\n" not in s and len([x for x in s.rstrip(".").split(",") if x.strip()]) == 5,
    "only_yes": lambda s: s.strip(" .!\"'") == "YES",
    "lowercase": lambda s: len(s) >= 15 and re.search(r"[a-z]", s) and s == s.lower(),
    "json_keys": lambda s: _json_keys(s) == {"name", "age"},
    "three_dashes": lambda s: (lambda L: len(L) == 3 and all(l.lstrip().startswith("-") for l in L))([l for l in s.splitlines() if l.strip()]),
    "num_10_20": lambda s: re.fullmatch(r"\d+", s.strip(" .")) is not None and 10 <= int(s.strip(" .")) <= 20,
    "no_e": lambda s: len(s) >= 15 and "e" not in s.lower(),
    "five_words": lambda s: len(_words(s)) == 5,
    "ends_done": lambda s: re.search(r"\bDONE[.!]?$", s.strip()) is not None and len(s.strip()) > 10,
    "repeat_fox": lambda s: re.sub(r"\s+", " ", s.strip().strip('"')) == "The quick brown fox.",
    "digit_3": lambda s: s.strip(" .") == "3",
    "elppa": lambda s: s.strip(" .\"'").lower() == "elppa",
    "reverse_5": lambda s: re.sub(r"\s+", " ", s.strip(" .")) == "5 4 3 2 1",
    "two_upper": lambda s: len(s.strip(" .").split()) == 2 and s.strip(" .") == s.strip(" .").upper() and re.search(r"[A-Z]", s) is not None,
    "title": lambda s: (lambda t: 0 < len(t.split()) <= 6 and not re.search(r"[^\w\s'’]", t) and
                        all(w[0].isupper() or w.lower() in SMALL for w in t.split()))(s.strip().strip('"*#').strip()),
}


def _json_keys(s):
    try:
        m = re.search(r"\{.*\}", s, re.S)
        j = json.loads(m.group(0) if m else s)
        return set(j) if isinstance(j, dict) else None
    except Exception:
        return None


def grade(q, reply):
    s = _clean(reply)
    if q["kind"] == "check":
        try:
            return bool(CHECK[q["answer"]](s))
        except Exception:
            return False
    last = [l for l in s.splitlines() if l.strip()]
    last = last[-1] if last else ""
    if q["kind"] == "num":
        n = _nums(last) or _nums(s)
        return bool(n) and abs(n[-1] - float(q["answer"])) < 1e-6
    if q["kind"] == "exact":
        return last.strip(" `\"'.").lower() == str(q["answer"]).lower()
    low = re.sub(r"[^a-z0-9 ]", " ", s.lower())
    return len(s) <= 300 and any(re.search(r"\b%s\b" % re.escape(a), low) for a in q["answer"])


if __name__ == "__main__":
    print(len(Q), {c: sum(1 for q in Q if q["cat"] == c) for c in ("math", "instructions", "facts", "code")})
