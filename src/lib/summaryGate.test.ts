import { describe, expect, it } from "vitest";
import { summaryTooShort } from "./summaryGate";

describe("summaryTooShort", () => {
  it("hides a short v2ex-style Chinese post that pads past 100 with spaces/English", () => {
    // Exact shape of v2ex #1243927: 114 plain chars, 49 hanzi (share ≈ 0.43).
    const hanzi = "请问这个链接为什么会被摘要捕获以及正文太短到底该不该显示摘要区呢大概五十字左右吧".slice(
      0,
      49,
    );
    const body = (hanzi + " " + "pad ".repeat(20)).slice(0, 114);
    expect(body.length).toBe(114);
    expect(summaryTooShort(body)).toBe(true);
  });

  it("hides any body under the total-length floor, English included", () => {
    expect(summaryTooShort("just a link post")).toBe(true);
    expect(summaryTooShort("")).toBe(true);
    expect(summaryTooShort("   ")).toBe(true);
  });

  it("shows a long English body with zero hanzi", () => {
    const body = "word ".repeat(40).trim(); // 199 chars, no CJK
    expect(body.length).toBeGreaterThanOrEqual(100);
    expect(summaryTooShort(body)).toBe(false);
  });

  it("shows a long English body that contains a couple of stray hanzi", () => {
    // ~3600 chars, 2 hanzi — share ≈ 0.0005, far under the 20% guard.
    const body = ("lorem ipsum dolor sit amet ".repeat(130) + "中文").slice(0, 3626);
    expect(summaryTooShort(body)).toBe(false);
  });

  it("shows a normal Chinese article once it clears the hanzi floor", () => {
    const body = "这是一篇正常的中文长文，".repeat(20); // 240 hanzi
    expect(summaryTooShort(body)).toBe(false);
  });
});
