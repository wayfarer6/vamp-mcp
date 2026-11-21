const notices = {
  en: 'Manual recording does not generate fallback code. When click verification is enabled, a failed check stops replay. Ask the user before adding YOLO checks or writing recovery steps.',
  ko: '수동 시연에서는 폴백 코드가 자동 생성되지 않습니다. 클릭 검증을 켠 상태에서 검증에 실패하면 재생이 멈춥니다. YOLO 검증을 추가하거나 복구 절차를 작성하기 전에 사용자에게 물어보세요.',
};

export function manualRecordingNotice(language) {
  return {fallback_generated: false, notice: language ? notices[language] : notices};
}
