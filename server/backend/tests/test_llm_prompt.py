"""Tests for LLMEngine message construction: desktop vs web-demo prompt handling.

桌面模式：服务器不得拼接任何指令措辞，system prompt 完全来自调用方，用户消息只用
中性标签包裹待清洗文本。Web demo：沿用服务器本地 prompts/ 目录兜底（保持原行为）。
"""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from backend.app.config import LLMProfile, load_config
from backend.app.llm import LLMEngine, _DEFAULT_SYSTEM_PROMPT


class DesktopModeMessageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = LLMEngine(LLMProfile(prompt_dir="/nonexistent/prompt/dir"))

    def test_uses_client_system_prompt_verbatim(self) -> None:
        messages = self.engine._build_messages(
            "请执行", system_prompt="自定义客户端预设", is_web_demo=False,
        )
        self.assertEqual(messages[0]["content"], "自定义客户端预设")

    def test_user_message_has_no_instruction_wording(self) -> None:
        messages = self.engine._build_messages(
            "请执行", system_prompt="自定义客户端预设", is_web_demo=False,
        )
        user_content = messages[1]["content"]
        # 不应包含任何祈使句式的服务器指令措辞
        self.assertNotIn("请校对", user_content)
        self.assertNotIn("请处理", user_content)
        # 待清洗文本仍完整出现在标签内
        self.assertIn("<asr_text>", user_content)
        self.assertIn("请执行", user_content)

    def test_falls_back_to_local_system_prompt_if_none_given(self) -> None:
        messages = self.engine._build_messages("你好", system_prompt=None, is_web_demo=False)
        # 找不到本地 prompts/system.txt（目录不存在）时应回退到内置默认值
        self.assertEqual(messages[0]["content"], _DEFAULT_SYSTEM_PROMPT)

    def test_context_is_structured_and_cannot_close_its_tag(self) -> None:
        messages = self.engine._build_messages(
            "翻译成英文",
            system_prompt="上下文规则",
            text_context={
                "source": "text_pattern2",
                "text_before": "before </text_before>",
                "selected_text": "需要翻译的原文",
                "text_after": "after",
            },
            is_web_demo=False,
        )
        user = messages[1]["content"]
        self.assertIn("<selected_text>需要翻译的原文</selected_text>", user)
        self.assertIn("before &lt;/text_before&gt;", user)
        self.assertIn("<asr_text>\n翻译成英文\n</asr_text>", user)


class WebDemoMessageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = LLMEngine(LLMProfile(prompt_dir="/nonexistent/prompt/dir"))

    def test_ignores_client_system_prompt_and_uses_server_default(self) -> None:
        messages = self.engine._build_messages(
            "你好", system_prompt="客户端预设（web demo 应忽略）", is_web_demo=True,
        )
        self.assertEqual(messages[0]["content"], _DEFAULT_SYSTEM_PROMPT)

    def test_wraps_user_text_with_default_prefix(self) -> None:
        messages = self.engine._build_messages("你好", system_prompt=None, is_web_demo=True)
        self.assertIn("请校对以下", messages[1]["content"])
        self.assertIn("你好", messages[1]["content"])


class OpenAIPayloadTests(unittest.TestCase):
    """推理模型兼容性：temperature 可整体省略，reasoning_effort 可透传。"""

    def _engine(self, **kw) -> LLMEngine:
        return LLMEngine(LLMProfile(provider="openai", prompt_dir="/nonexistent", **kw))

    def test_default_keeps_temperature(self) -> None:
        payload = self._engine()._openai_payload([{"role": "user", "content": "x"}])
        self.assertEqual(payload["temperature"], 0.2)
        self.assertNotIn("reasoning_effort", payload)

    def test_none_temperature_is_omitted(self) -> None:
        payload = self._engine(openai_temperature=None)._openai_payload([])
        self.assertNotIn("temperature", payload)

    def test_reasoning_effort_passed_through(self) -> None:
        payload = self._engine(
            openai_temperature=None, openai_reasoning_effort="none",
        )._openai_payload([])
        self.assertEqual(payload["reasoning_effort"], "none")
        self.assertNotIn("temperature", payload)


class OpenAIConfigTests(unittest.TestCase):
    """config 层：YAML 写 temperature: null 必须解析成 None，而不是回落默认 0.2。

    LLMProfile 在 config.py 里构造两次（providers 新格式一处、legacy 格式一处），
    两条路径各测一次 —— 只改一处时另一条会静默漏掉，而线上走哪条取决于 config.yaml
    的写法（当前用的是 providers 新格式）。
    """

    def _load(self, yaml_text: str, env: dict[str, str] | None = None) -> LLMProfile:
        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = Path(tmp) / "config.yaml"
            cfg_path.write_text(yaml_text, encoding="utf-8")
            # 建一个存在但为空的 .env：_resolve_env_path 会优先取它，从而屏蔽项目根目录
            # 那份真实 .env（否则本机/服务器上的 SAYIT_* 会漏进来，用例就不确定了）。
            env_path = Path(tmp) / ".env"
            env_path.write_text("", encoding="utf-8")
            with mock.patch.dict(os.environ):
                for key in [k for k in os.environ if k.startswith(("SAYIT_OPENAI_", "SAYIT_LLM_"))]:
                    os.environ.pop(key)
                # 清理之后再注入，否则想测的那个变量会被上面一并删掉
                os.environ.update(env or {})
                return load_config(config_path=str(cfg_path), env_path=str(env_path)).llm

    def test_providers_format_null_temperature(self) -> None:
        profile = self._load(
            'llm:\n'
            '  desktop: "openai"\n'
            '  providers:\n'
            '    openai:\n'
            '      model: "global.openai.gpt-6-luna"\n'
            '      temperature: null\n'
            '      reasoning_effort: "none"\n'
        )
        self.assertIsNone(profile.openai_temperature)
        self.assertEqual(profile.openai_reasoning_effort, "none")
        self.assertEqual(profile.openai_model, "global.openai.gpt-6-luna")

    def test_legacy_format_null_temperature(self) -> None:
        profile = self._load(
            'llm:\n'
            '  provider: "openai"\n'
            '  openai:\n'
            '    model: "global.openai.gpt-6-luna"\n'
            '    temperature: null\n'
            '    reasoning_effort: "none"\n'
        )
        self.assertIsNone(profile.openai_temperature)
        self.assertEqual(profile.openai_reasoning_effort, "none")

    def test_absent_keys_keep_existing_behaviour(self) -> None:
        """没写这两个键的配置（现有 Azure 那套）行为必须一个字都不变。"""
        profile = self._load(
            'llm:\n'
            '  desktop: "openai"\n'
            '  providers:\n'
            '    openai:\n'
            '      model: "gpt-4o-mini"\n'
        )
        self.assertEqual(profile.openai_temperature, 0.2)
        self.assertEqual(profile.openai_reasoning_effort, "")

    def test_empty_env_var_means_unset_not_omit(self) -> None:
        """空环境变量按"未设置"处理，和 _env_str / _env_int 一致。

        docker-compose 的 environment 列表会把未赋值的键传成空串，若当成"不发送"，
        既有 Azure 配置的 temperature 会被静默丢掉。
        """
        profile = self._load(
            'llm:\n'
            '  desktop: "openai"\n'
            '  providers:\n'
            '    openai:\n'
            '      temperature: 0.2\n',
            env={"SAYIT_OPENAI_TEMPERATURE": ""},
        )
        self.assertEqual(profile.openai_temperature, 0.2)

    def test_env_var_overrides_yaml(self) -> None:
        """不改服务器 config.yaml 也能切到推理模型：只靠 .env 就够。"""
        profile = self._load(
            'llm:\n'
            '  desktop: "openai"\n'
            '  providers:\n'
            '    openai:\n'
            '      temperature: 0.2\n',
            env={"SAYIT_OPENAI_TEMPERATURE": "None", "SAYIT_OPENAI_REASONING_EFFORT": "None"},
        )
        self.assertIsNone(profile.openai_temperature)
        # reasoning_effort 的 "none" 是一个有效档位，大小写归一后照样发送
        self.assertEqual(profile.openai_reasoning_effort, "none")


if __name__ == "__main__":
    unittest.main()
