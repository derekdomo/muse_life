# Data Plan

## User-owned training data

- Source: entries created through the artifact's workout actions and stored in `app.db`.
- Used for: active workout state, set completion, weight/repetition history, progression prefill, recent history, and the calendar-week review.
- Refresh: queries invalidate immediately after each mutation.
- Empty state: the artifact asks the user to complete a first workout and does not invent history.

## Curated technique videos

The exercise-guide dialogs contain original short form cues plus outbound links to public human-demonstration videos. The artifact does not fetch or embed these videos, and no external data is loaded when the page opens.

- Barbell bench press: https://www.youtube.com/watch?v=CjHIKDQ4RQo
- Standing overhead press: https://www.youtube.com/watch?v=EK511FpyDEg
- Incline dumbbell press: https://www.youtube.com/watch?v=oZVCBM9f8Eo
- Chest dips: https://www.youtube.com/watch?v=2HYAeF6o7Bc
- Dumbbell lateral raise: https://www.youtube.com/watch?v=z-kOn7flIZg
- Wide-grip lat pulldown: https://www.youtube.com/shorts/UAlGHwshYBM
- Underhand lat pulldown: https://www.youtube.com/watch?v=UkgDc61gRcM
- Close seated cable row: https://www.youtube.com/watch?v=O9nVMz5osqY
- Wide versus close seated cable row: https://www.youtube.com/shorts/mJLT0tChvFM
- Seated cable face pull: https://www.youtube.com/watch?v=4UhV4cCkugM
- Cable rope curl: https://www.youtube.com/watch?v=dLRVpRC4L3Y
- Squat technique: https://www.youtube.com/watch?v=nEQQle9-0NA
- Romanian deadlift: https://www.youtube.com/watch?v=aa57T45iFSE
- Bulgarian split squat: https://www.youtube.com/watch?v=DeCnHqrN22U
- Lying leg curl: https://www.youtube.com/shorts/tLyA9uXn5Wo

## Weekly recommendation logic

- The review uses the viewer's current calendar week (Monday through now) and the stored completed workouts.
- It reports only recorded session and completed-set counts.
- The next-week adjustment is deliberately conservative: retain the existing compound movements and add one unilateral leg exercise (Bulgarian split squat, 3 × 8–10) because the previous leg template contained bilateral squat, hip hinge, and hamstring isolation but no unilateral knee-dominant work.
