import { describe, expect, test } from "bun:test"
import { SessionPlan } from "../../src/session/plan.js"

describe("SessionPlan naming", () => {
  test("matches iteration from a convention filename", () => {
    expect(SessionPlan.matchIteration("00-plan.md", "${iteration}-${slug}.md")).toBe("00")
    expect(SessionPlan.matchIteration("00.01-detail.md", "${iteration}-${slug}.md")).toBe("00.01")
    expect(SessionPlan.matchIteration("readme.md", "${iteration}-${slug}.md")).toBeUndefined()
  })

  test("nextIteration picks the next top-level index, ignoring subplans", () => {
    expect(SessionPlan.nextIteration([])).toBe("00")
    expect(SessionPlan.nextIteration(["00", "01"])).toBe("02")
    expect(SessionPlan.nextIteration(["00", "00.01", "00.02"])).toBe("01")
    expect(SessionPlan.nextIteration(["07"])).toBe("08")
  })
})
