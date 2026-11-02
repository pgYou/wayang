import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '@/tui/theme';
import {
  buildSelectChoices,
  formatCustomAnswer,
  INQUIRE_OTHER_OPTION,
  isOtherChoice,
  type InquireQuestion,
} from '@/types/index';

interface InquiryPromptProps {
  inquiry: InquireQuestion;
  onAnswer: (answer: string) => void;
}

export function InquiryPrompt({ inquiry, onAnswer }: InquiryPromptProps) {
  if (inquiry.type === 'confirm') {
    return <ConfirmPrompt message={inquiry.message} defaultVal={inquiry.default} onAnswer={onAnswer} />;
  }
  if (inquiry.type === 'select') {
    return (
      <SelectPrompt
        message={inquiry.message}
        options={inquiry.options ?? []}
        allowOther={inquiry.allowOther}
        onAnswer={onAnswer}
      />
    );
  }
  return <TextPrompt message={inquiry.message} onAnswer={onAnswer} />;
}

// --- Confirm ---

function ConfirmPrompt({ message, defaultVal, onAnswer }: {
  message: string;
  defaultVal?: string;
  onAnswer: (answer: string) => void;
}) {
  const opts = ['Yes', 'No'];
  const defaultIndex = defaultVal === 'No' ? 1 : 0;
  const [selected, setSelected] = useState(defaultIndex);

  useInput((_ch, key) => {
    if (key.leftArrow) setSelected(0);
    if (key.rightArrow) setSelected(1);
    if (key.return) onAnswer(opts[selected]);
  });

  return (
    <Box flexDirection="column">
      <Box paddingX={1} borderStyle="single" borderColor="gray" borderLeft={false} borderRight={false}>
        <Text color="cyan">? </Text>
        <Text bold>{message}</Text>
      </Box>
      <Box paddingX={2} marginTop={0}>
        {opts.map((opt, i) => (
          <React.Fragment key={opt}>
            {i > 0 && <Text>  </Text>}
            <Text color={i === selected ? theme.baseToken.color.accent : undefined} bold={i === selected} inverse={i === selected}>
              {` ${opt} `}
            </Text>
          </React.Fragment>
        ))}
      </Box>
    </Box>
  );
}

// --- Select ---

/**
 * Select prompt with an "Other" escape: the option list gets a trailing
 * free-input choice (see buildSelectChoices), and picking it switches to a
 * text input. The custom answer is marked with the "[Other] " prefix so the
 * controller can distinguish it from a preset-option pick.
 */
function SelectPrompt({ message, options, allowOther, onAnswer }: {
  message: string;
  options: string[];
  allowOther?: boolean;
  onAnswer: (answer: string) => void;
}) {
  const [awaitingCustom, setAwaitingCustom] = useState(false);

  if (awaitingCustom) {
    return (
      <TextPrompt
        message={message}
        inputLabel={INQUIRE_OTHER_OPTION}
        onAnswer={(text) => onAnswer(formatCustomAnswer(text))}
      />
    );
  }

  return (
    <SelectList
      message={message}
      options={options}
      allowOther={allowOther}
      onAnswer={onAnswer}
      onRequestCustom={() => setAwaitingCustom(true)}
    />
  );
}

function SelectList({ message, options, allowOther, onAnswer, onRequestCustom }: {
  message: string;
  options: string[];
  allowOther?: boolean;
  onAnswer: (answer: string) => void;
  onRequestCustom: () => void;
}) {
  const choices = buildSelectChoices(options, allowOther);
  const [selected, setSelected] = useState(0);

  useInput((_ch, key) => {
    if (key.upArrow && choices.length > 0) setSelected(i => (i - 1 + choices.length) % choices.length);
    if (key.downArrow && choices.length > 0) setSelected(i => (i + 1) % choices.length);
    if (key.return && choices.length > 0) {
      const choice = choices[selected];
      if (isOtherChoice(choice)) onRequestCustom();
      else onAnswer(choice);
    }
  });

  return (
    <Box flexDirection="column">
      <Box paddingX={1} borderStyle="single" borderColor="gray" borderLeft={false} borderRight={false}>
        <Text color="cyan">? </Text>
        <Text bold>{message}</Text>
      </Box>
      <Box flexDirection="column" paddingX={1}>
        {choices.map((choice, i) => (
          <Box key={i}>
            <Text color={i === selected ? theme.baseToken.color.accent : undefined}>
              {i === selected ? '▸ ' : '  '}
            </Text>
            <Text bold={i === selected} color={i === selected ? theme.baseToken.color.accent : undefined} dimColor={isOtherChoice(choice) && i !== selected}>
              {choice}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

// --- Text ---

function TextPrompt({ message, onAnswer, inputLabel }: {
  message: string;
  onAnswer: (answer: string) => void;
  /** Optional dim label shown before the input (e.g. the "Other" choice the user picked). */
  inputLabel?: string;
}) {
  const [input, setInput] = useState('');
  const [cursor, setCursor] = useState(0);

  useInput((ch, key) => {
    if (key.return) {
      const trimmed = input.trim();
      if (trimmed) onAnswer(trimmed);
      return;
    }
    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      setInput(prev => prev.slice(0, cursor - 1) + prev.slice(cursor));
      setCursor(c => Math.max(0, c - 1));
      return;
    }
    if (key.leftArrow) { setCursor(c => Math.max(0, c - 1)); return; }
    if (key.rightArrow) { setCursor(c => Math.min(input.length, c + 1)); return; }
    if (ch && !key.ctrl && !key.meta) {
      setInput(prev => prev.slice(0, cursor) + ch + prev.slice(cursor));
      setCursor(c => c + ch.length);
    }
  });

  const before = input.slice(0, cursor);
  const after = input.slice(cursor);

  return (
    <Box flexDirection="column">
      <Box paddingX={1} borderStyle="single" borderColor="gray" borderLeft={false} borderRight={false}>
        <Text color="cyan">? </Text>
        <Text bold>{message}</Text>
      </Box>
      <Box paddingX={1} borderStyle="single" borderColor="gray" borderLeft={false} borderRight={false}>
        {inputLabel ? <Text dimColor>  {inputLabel}: </Text> : <Text>  </Text>}
        <Text>{before}</Text>
        <Text color="white" inverse>{after.length > 0 ? after[0] : ' '}</Text>
        <Text>{after.slice(1)}</Text>
      </Box>
    </Box>
  );
}
