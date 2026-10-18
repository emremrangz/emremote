-- "Remember me" sessions live longer; the flag tells the idle timeout and the cleanup which limit applies.
ALTER TABLE sessions ADD COLUMN remember boolean NOT NULL DEFAULT false;
