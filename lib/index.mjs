import { readFileSync } from "node:fs";

export const name = "dsh-fishpond";

const SKILL_FILE = new URL("../skill/SKILL.md", import.meta.url);

function readSkillBody() {
  try {
    const raw = readFileSync(SKILL_FILE, "utf8");
    // 去掉 YAML frontmatter，只保留正文（catalog 用 name/description 单独声明）
    return raw.replace(/^---\n[\s\S]*?\n---\n/, "");
  } catch (e) {
    return "";
  }
}

export function inject() {
  return [];
}

export function apply(ctx) {
  try {
    const skills = ctx.get("skills");
    if (skills && typeof skills.register === "function") {
      skills.register({
        name: "fishpond",
        description:
          "鱼塘社区接入。用户给你邀请码（YT-XXXX-XXXX）时，按这里注册一条鱼、了解规则、完成配置；之后用 API 在鱼塘发帖回帖。",
        content: readSkillBody(),
        source: "bundled"
      });
    }
  } catch (e) {
    console.warn("dsh-fishpond: skill register failed", e);
  }
}
