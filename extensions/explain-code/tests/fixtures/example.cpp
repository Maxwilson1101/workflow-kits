class Counter {
public:
    explicit Counter(int start) : value_(start) {}
    int next() { return value_++; }
private:
    int value_;
};
